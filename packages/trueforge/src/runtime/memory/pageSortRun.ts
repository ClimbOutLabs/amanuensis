/**
 * Runs the sorter on the notes a turn has just saved, after the reply and off its path. It uses the model the
 * save-time summarizer uses and the same limit on calls at once. A failure is logged and never reaches the save.
 */
import { execFileRunner, extractErrorLogFields, withTimeout } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { WrittenEntry } from './hindsightClient';
import { localDay } from './localDay';
import { entryRecallText, recallMetadata } from './markdownMemoryFiles';
import type { MemoryClient } from './memoryClient';
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

/** The model the sorter asks: the summarizer's client, limits, time budget and light-reasoning request. */
export function summaryModelForSorting({
  summarize,
  logger,
}: {
  summarize: SummarizeTurnContext;
  logger: Logger;
}): SortModel | undefined {
  const modelFqn = summarize.summarizationModelFqn;
  if (modelFqn === undefined || modelFqn.trim() === '') {
    return undefined;
  }
  const resolveLlm = summarize.resolveLlm ?? summaryLlmResolver({ ...summarize, logger });
  return async messages => {
    const answer = await askSummaryModel({
      messages,
      modelFqn,
      resolveLlm,
      isReadable: reply => SortReplySchema.safeParse(extractReplyJson(reply)).success,
      maxOutputTokens: SORT_MAX_OUTPUT_TOKENS,
      logger,
    });
    if (answer.status === 'failed') {
      return { ok: false, reason: answer.reason };
    }
    if (answer.reply === '') {
      return { ok: false, reason: answer.cutShort ? 'the reply was cut short' : 'the reply was empty' };
    }
    return { ok: true, reply: answer.reply };
  };
}

function noteOf({ entry, today }: { entry: WrittenEntry; today: string }): SortNote {
  return {
    id: entry.id,
    text: entryRecallText(entry.text),
    day: NOTE_DAY_PATTERN.exec(entry.id)?.[1] ?? today,
    metadata: recallMetadata(entry.text),
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
    const pagesByMeaning = client.pagesByMeaning?.bind(client);
    for (const entry of written) {
      await sortNote({
        mode,
        note: noteOf({ entry, today }),
        askModel,
        options: { vaultDir, runner: execFileRunner, today, logger },
        similarPages:
          pagesByMeaning === undefined
            ? undefined
            : text =>
                withTimeout(
                  pagesByMeaning({ text, limit: SORT_MAX_SHOWN_PAGES }),
                  SIMILAR_PAGES_TIMEOUT_MS,
                  'finding pages by meaning',
                ),
      });
    }
  } catch (error) {
    logger.warn('Sorting saved notes onto pages failed.', extractErrorLogFields(error));
  }
}
