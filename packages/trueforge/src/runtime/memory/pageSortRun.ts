/**
 * Runs the sorter on the notes a turn has just saved, after the reply and off its path. It uses the model the
 * save-time summarizer uses and the same limit on calls at once. A failure is logged and never reaches the save.
 */
import { execFileRunner, extractErrorLogFields, withTimeout } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import { readMemoryHelperWaitMinutes } from '../memoryHelperWaitSettings';
import { localDay } from './localDay';
import { entryMetadata, entryRecallText } from './markdownMemoryFiles';
import type { MemoryClient, WrittenEntry } from './memoryClient';
import type { PageListing } from './memoryPages';
import type { SummarizeTurnContext } from './memoryRetain';
import { askSummaryModel, extractReplyJson, summaryLlmResolver } from './memorySummarize';
import { SortReplySchema } from './pageSortDecisions';
import type { PageSortMode } from './pageSortMode';
import { SORT_MAX_SHOWN_PAGES } from './pageSortPrompt';
import { sortNote, type SortModel, type SortNote } from './pageSorter';

/** Cap on generated tokens: up to eight decisions with a reason each. */
const SORT_MAX_OUTPUT_TOKENS = 1600;

/** The longest the search by meaning may hold up one note. */
const SIMILAR_PAGES_TIMEOUT_MS = 10_000;

const NOTE_DAY_PATTERN = /:(\d{4}-\d{2}-\d{2})\.md#\d+$/;

/**
 * The model a helper job asks: the summarizer's client, limits and light-reasoning request. Nobody waits on these
 * questions, so one try may take as long as the person chose in Settings; the model client still gives up sooner
 * on a model that has stopped sending anything.
 */
export function summaryModelFor({
  summarize,
  logger,
  isReadable,
  maxOutputTokens,
}: {
  summarize: SummarizeTurnContext;
  logger: Logger;
  /** Says whether a reply holds an answer; a cut-off reply that does not is asked again with more room. */
  isReadable: (reply: string) => boolean;
  maxOutputTokens: number;
}): SortModel | undefined {
  const modelFqn = summarize.summarizationModelFqn;
  if (modelFqn === undefined || modelFqn.trim() === '') {
    return undefined;
  }
  return async messages => {
    const waitMinutes = await readMemoryHelperWaitMinutes({
      globalSettingsStore: summarize.globalSettingsStore,
      logger,
    });
    const resolveLlm =
      summarize.resolveLlm ?? summaryLlmResolver({ ...summarize, logger, timeoutMs: waitMinutes * 60_000 });
    const askedAt = Date.now();
    const answer = await askSummaryModel({ messages, modelFqn, resolveLlm, isReadable, maxOutputTokens, logger });
    // How long the model takes says whether a helper job suits it; the question and the answer are not logged.
    logger.info('A memory helper question came back from the model.', {
      seconds: Math.round((Date.now() - askedAt) / 1000),
      answered: answer.status === 'answered' && answer.reply !== '',
    });
    if (answer.status === 'failed') {
      return answer.fallback === 'model_timeout'
        ? { ok: false, reason: answer.reason, cause: 'model_slow' }
        : { ok: false, reason: answer.reason };
    }
    if (answer.reply === '') {
      return answer.cutShort
        ? { ok: false, reason: 'the reply was cut short', cause: 'reply_cut_short' }
        : { ok: false, reason: 'the reply was empty', cause: 'reply_empty' };
    }
    return { ok: true, reply: answer.reply };
  };
}

/** The model the sorter asks. */
export function summaryModelForSorting({
  summarize,
  logger,
}: {
  summarize: SummarizeTurnContext;
  logger: Logger;
}): SortModel | undefined {
  return summaryModelFor({
    summarize,
    logger,
    isReadable: reply => SortReplySchema.safeParse(extractReplyJson(reply)).success,
    maxOutputTokens: SORT_MAX_OUTPUT_TOKENS,
  });
}

/** Finds the pages whose statements are closest in meaning to a text; undefined for a client with no meaning search. */
export function similarPagesFinder(client: MemoryClient): ((text: string) => Promise<PageListing[]>) | undefined {
  const pagesByMeaning = client.pagesByMeaning?.bind(client);
  return pagesByMeaning === undefined
    ? undefined
    : text =>
        withTimeout(
          pagesByMeaning({ text, limit: SORT_MAX_SHOWN_PAGES }),
          SIMILAR_PAGES_TIMEOUT_MS,
          'finding pages by meaning',
        );
}

/** A daily-log entry as the sorter reads it; the day comes from the entry id, else `today`. */
export function noteOf({ entry, today }: { entry: WrittenEntry; today: string }): SortNote {
  return {
    id: entry.id,
    text: entryRecallText(entry.text),
    day: NOTE_DAY_PATTERN.exec(entry.id)?.[1] ?? today,
    metadata: entryMetadata(entry.text),
  };
}

/**
 * Sorts each note a save has just written, one after the other. Does nothing with sorting off, with a client
 * that keeps no pages, or with no model configured. Never throws.
 */
export async function sortWrittenNotes({
  mode,
  client,
  written,
  summarize,
  timeZone,
  logger,
}: {
  mode: PageSortMode;
  client: MemoryClient;
  written: readonly WrittenEntry[];
  summarize: SummarizeTurnContext | undefined;
  timeZone: string | undefined;
  logger: Logger;
}): Promise<void> {
  try {
    const vaultDir = client.pagesWriteDir?.();
    const askModel = summarize === undefined ? undefined : summaryModelForSorting({ summarize, logger });
    if (mode === 'off' || vaultDir === undefined || askModel === undefined) {
      return;
    }
    const today = localDay({ instant: new Date(), timeZone }).date;
    const similarPages = similarPagesFinder(client);
    for (const entry of written) {
      await sortNote({
        mode,
        note: noteOf({ entry, today }),
        askModel,
        options: { vaultDir, runner: execFileRunner, today, logger },
        similarPages,
      });
    }
  } catch (error) {
    logger.warn('Sorting saved notes onto pages failed.', extractErrorLogFields(error));
  }
}
