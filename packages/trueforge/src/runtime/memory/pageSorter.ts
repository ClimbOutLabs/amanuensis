/**
 * Sorts one saved note onto pages. One model call proposes decisions; the host checks them, holds them to the
 * note's origin and writes the pages itself. The model never names a file and never chooses a source.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import { appendHandledNote, type HandledOutcome } from './handledNotes';
import { noteTextWithoutLabel } from './memoryNotes';
import type { PageListing } from './memoryPages';
import {
  addFact,
  moveFactToEarlier,
  newMemoryPage,
  pageFacts,
  readMemoryPage,
  withFactMarker,
  writeMemoryPage,
  type FactLocation,
  type MemoryPage,
  type PageKind,
} from './memoryPages';
import { commitPageChange, type PageChangeOptions } from './memoryPageWriter';
import { extractReplyJson } from './memorySummarize';
import { SortReplySchema, type SortDecision } from './pageSortDecisions';
import type { PageSortMode, SortStopCause } from './pageSortMode';
import { noteOriginOf, statementSourceOf, type NoteOrigin } from './pageSortOrigin';
import { buildSortPrompt, type ShownStatement } from './pageSortPrompt';
import { appendSortReport, type SortReportLine } from './pageSortReport';
import { ruleDecisions, type PlannedDecision } from './pageSortRules';
import { currentFactsSaying, sameText, sectionAfterChange, statementWith, uniqueFactId } from './pageStatements';

/** Longest model reply read; a longer one is refused whole, never cut. */
const SORT_MAX_REPLY_CHARACTERS = 8000;

/** The answer from the model call, or why there is none. */
export type SortModelAnswer =
  | { ok: true; reply: string }
  | { ok: false; reason: string; cause?: Extract<SortStopCause, 'model_slow' | 'reply_empty' | 'reply_cut_short'> };

/** Asks the model one question. Never throws. */
export type SortModel = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<SortModelAnswer>;

/** A saved note as the sorter reads it. */
export interface SortNote {
  /** `md:<vault>:<day>.md#<position>` */
  id: string;
  /** The note's text without its heading and hidden lines. */
  text: string;
  /** The day the note was saved, `YYYY-MM-DD`. */
  day: string;
  /** What `entryMetadata` says about the note: its origin and source. */
  metadata: Readonly<Record<string, string>>;
}

/**
 * - `sorted`: the reply was understood. `written` is false in report mode. `decisions` are the ones after the host's rules.
 * - `refused`: the reply could not be trusted, so nothing was written and the note stays unsorted.
 * - `failed`: the call or a write failed; the note stays unsorted.
 */
export type SortResult =
  | { status: 'off' }
  | { status: 'sorted'; written: boolean; outcome: Exclude<HandledOutcome, 'chat'>; decisions: SortDecision[] }
  | { status: 'refused'; reason: string; cause: SortStopCause }
  | { status: 'failed'; reason: string; cause: SortStopCause };

/** A page changed after the model saw it, so the decision no longer fits. */
class StalePageError extends Error {
  constructor() {
    super('A page changed while the note was being sorted.');
    this.name = 'StalePageError';
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(word => word !== '')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The one current statement on the page the model named, found by its id, else by its words. */
function locateTarget({ page, target }: { page: MemoryPage; target: ShownStatement }): FactLocation {
  const byId = pageFacts(page).find(
    at => at.section.name !== 'Earlier' && target.id !== undefined && at.fact.marker.id === target.id,
  );
  if (byId !== undefined) {
    if (!sameText({ a: byId.fact.text, b: target.text })) {
      throw new StalePageError();
    }
    return byId;
  }
  const byText = currentFactsSaying({ page, text: target.text });
  const [only] = byText;
  if (only === undefined || byText.length > 1) {
    throw new StalePageError();
  }
  return only;
}

function countWords(planned: readonly PlannedDecision[]): string {
  const labels: Readonly<Record<SortDecision['decision'], string>> = {
    new: 'new',
    same: 'seen again',
    changed: 'changed',
    ended: 'ended',
    unconfirmed: 'not confirmed',
    ignore: 'ignored',
  };
  const counts = new Map<string, number>();
  for (const { decision } of planned) {
    if (decision.decision !== 'ignore') {
      counts.set(labels[decision.decision], (counts.get(labels[decision.decision]) ?? 0) + 1);
    }
  }
  return [...counts].map(([label, count]) => `${String(count)} ${label}`).join(', ');
}

/** Makes every planned decision on the pages as they are now and writes the pages that changed. */
async function applyPlanned({
  vaultDir,
  planned,
  origin,
  day,
  newId,
}: {
  vaultDir: string;
  planned: readonly PlannedDecision[];
  origin: NoteOrigin;
  day: string;
  newId: () => string;
}): Promise<void> {
  const src = statementSourceOf(origin);
  const pages = new Map<string, { kind: PageKind; slug: string; page: MemoryPage }>();
  const open = async ({
    kind,
    slug,
  }: PageListing): Promise<{ kind: PageKind; slug: string; page: MemoryPage } | undefined> => {
    const key = `${kind}/${slug}`;
    const held = pages.get(key);
    if (held !== undefined) {
      return held;
    }
    const page = await readMemoryPage({ vaultDir, kind, slug });
    return page === undefined ? undefined : { kind, slug, page };
  };
  const keep = (entry: { kind: PageKind; slug: string; page: MemoryPage }) => {
    pages.set(`${entry.kind}/${entry.slug}`, entry);
  };

  for (const { decision, kind, target, guessed } of planned) {
    switch (decision.decision) {
      case 'ignore':
        break;
      case 'same':
      case 'changed':
      case 'ended': {
        const held = kind === undefined ? undefined : await open({ kind, slug: decision.about });
        if (held === undefined || target === undefined || kind === undefined) {
          throw new StalePageError();
        }
        const at = locateTarget({ page: held.page, target });
        if (decision.decision === 'same') {
          keep({ ...held, page: withFactMarker(held.page, { at, marker: { ...at.fact.marker, seen: day } }) });
          break;
        }
        // The host's rules already turned these into unconfirmed lines; this guards a statement that was edited since.
        const own = at.fact.marker.src === 'you_said' || at.fact.marker.src === 'you_edited';
        if (origin.kind === 'read' || (origin.kind === 'sent_mail' && own)) {
          throw new StalePageError();
        }
        const moved = moveFactToEarlier(held.page, {
          at,
          until: decision.decision === 'changed' ? decision.until_old : decision.until,
        });
        keep({
          ...held,
          page:
            decision.decision === 'changed'
              ? addFact(moved, {
                  section: sectionAfterChange(at),
                  fact: statementWith({
                    text: decision.new_text,
                    id: uniqueFactId({ page: moved, newId }),
                    src,
                    since: decision.since_new,
                  }),
                })
              : moved,
        });
        break;
      }
      case 'new':
      case 'unconfirmed': {
        if (kind === undefined) {
          throw new StalePageError();
        }
        const existing = await open({ kind, slug: decision.about });
        const held = existing ?? {
          kind,
          slug: decision.about,
          page: newMemoryPage({ kind, title: decision.title ?? titleFromSlug(decision.about) }),
        };
        // A line a page already holds is never written twice.
        if (currentFactsSaying({ page: held.page, text: decision.text }).length > 0) {
          keep(held);
          break;
        }
        keep({
          ...held,
          page:
            decision.decision === 'new'
              ? addFact(held.page, {
                  section: decision.section,
                  fact: statementWith({
                    text: decision.text,
                    id: uniqueFactId({ page: held.page, newId }),
                    src,
                    since: decision.since ?? day,
                    until: decision.until,
                  }),
                })
              : addFact(held.page, {
                  section: 'Unconfirmed',
                  fact: statementWith({
                    text: decision.text,
                    id: uniqueFactId({ page: held.page, newId }),
                    src: guessed ? 'inferred' : src,
                    seen: decision.seen,
                  }),
                }),
        });
        break;
      }
    }
  }
  for (const { kind, slug, page } of pages.values()) {
    await writeMemoryPage({ vaultDir, kind, slug, page });
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function report({
  mode,
  vaultDir,
  logger,
  line,
}: {
  mode: PageSortMode;
  vaultDir: string;
  logger: Logger;
  line: SortReportLine;
}): Promise<void> {
  if (mode !== 'report') {
    return;
  }
  try {
    await appendSortReport({ vaultDir, line });
  } catch (error) {
    logger.warn('The sorting report could not be written.', extractErrorLogFields(error));
  }
}

/**
 * Sorts one saved note. Never throws. In `report` mode the model is asked and the decisions are checked exactly as
 * in `on`, but no page and no handled-note line is written. A refused reply, a failed call or a failed write leaves
 * the note unsorted.
 */
export async function sortNote({
  mode,
  note,
  askModel,
  options,
  similarPages,
}: {
  mode: PageSortMode;
  note: SortNote;
  askModel: SortModel;
  /** What a page change needs, including the vault folder. */
  options: PageChangeOptions;
  /** Pages whose statements are closest in meaning to a text; absent until the meaning search is ready. */
  similarPages?: ((text: string) => Promise<PageListing[]>) | undefined;
}): Promise<SortResult> {
  if (mode === 'off') {
    return { status: 'off' };
  }
  const { vaultDir, logger } = options;
  const line = { note_id: note.id, day: note.day };
  const stop = async (result: Extract<SortResult, { status: 'refused' | 'failed' }>): Promise<SortResult> => {
    logger.info(
      result.status === 'refused'
        ? 'A saved note was not sorted onto pages, because the reply could not be trusted.'
        : 'A saved note was not sorted onto pages, because the work failed.',
      { noteId: note.id, reason: result.reason },
    );
    await report({
      mode,
      vaultDir,
      logger,
      line: { ...line, outcome: result.status, decisions: [], reason: result.reason },
    });
    return result;
  };

  const origin = noteOriginOf(note.metadata);
  // Only a note with a source carries a label. The prompt states the origin itself, so the label is not shown:
  // a model reads the assistant's name in it as someone the note is about.
  const said = { ...note, text: origin.kind === 'own_words' ? note.text : noteTextWithoutLabel(note.text) };
  if (said.text.trim() === '') {
    return stop({ status: 'failed', reason: 'the note is empty', cause: 'note_empty' });
  }
  let prompt: Awaited<ReturnType<typeof buildSortPrompt>>;
  try {
    prompt = await buildSortPrompt({ vaultDir, note: said, origin, similarPages });
  } catch (error) {
    return stop({
      status: 'failed',
      reason: `the pages could not be read: ${reasonOf(error)}`,
      cause: 'pages_unreadable',
    });
  }
  const answer = await askModel(prompt.messages);
  if (!answer.ok) {
    return stop({ status: 'failed', reason: answer.reason, cause: answer.cause ?? 'model_error' });
  }
  if (answer.reply.length > SORT_MAX_REPLY_CHARACTERS) {
    return stop({ status: 'refused', reason: 'the reply was too long', cause: 'reply_too_long' });
  }
  const parsed = SortReplySchema.safeParse(extractReplyJson(answer.reply));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return stop({
      status: 'refused',
      cause: 'reply_wrong_form',
      reason: `the reply was not in the expected shape${issue === undefined ? '' : ` (${issue.path.join('.')}: ${issue.message})`}`,
    });
  }
  const ruled = ruleDecisions({
    decisions: parsed.data.decisions,
    origin,
    noteText: said.text,
    day: note.day,
    shown: prompt.shown,
    known: prompt.known,
    words: prompt.words,
  });
  if (!ruled.ok) {
    return stop({ status: 'refused', reason: ruled.reason, cause: 'reply_broke_rule' });
  }
  const decisions = ruled.planned.map(({ decision }) => decision);
  const outcome: Exclude<HandledOutcome, 'chat'> = decisions.some(decision => decision.decision !== 'ignore')
    ? 'page'
    : 'none';

  if (mode === 'report') {
    await report({ mode, vaultDir, logger, line: { ...line, outcome: 'sorted', decisions } });
    return { status: 'sorted', written: false, outcome, decisions };
  }
  try {
    if (outcome === 'page') {
      await commitPageChange({
        options,
        message: `Aman sorted a saved note onto pages (${countWords(ruled.planned)})`,
        change: ({ newId }) => applyPlanned({ vaultDir, planned: ruled.planned, origin, day: note.day, newId }),
      });
    }
    await appendHandledNote({ vaultDir, noteId: note.id, outcome });
  } catch (error) {
    logger.warn('A saved note could not be sorted onto pages.', { noteId: note.id, ...extractErrorLogFields(error) });
    return { status: 'failed', reason: reasonOf(error), cause: 'write_failed' };
  }
  return { status: 'sorted', written: true, outcome, decisions };
}
