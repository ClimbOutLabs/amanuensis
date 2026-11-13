/**
 * Decides, once for a message, whether it is clearly about something remembered, and which page statements
 * and daily-log notes it is about. Page statements and eligible log notes are judged together under the two
 * rules, so the page path and the log path always get the same answer for one message.
 */
import { withTimeout } from '@truefoundry/trueforge-core/core';

import { EMBEDDING_DIMENSIONS, type EmbeddingModel } from './embeddingModel';
import type { EmbeddingSubsystem } from './embeddingRetrieval';
import { readHandledNotes, type HandledOutcome } from './handledNotes';
import { entryMetadata, recallExcludedIds, type NamespaceScan } from './markdownMemoryFiles';
import { MEMORY_ORIGIN_METADATA_KEY, USER_STATED_ORIGIN } from './memoryOrigin';
import { noteIndexFor, type NoteIndex } from './noteIndex';
import { emptyBest, percentileBar, raiseBest, STANDING_ABOVE, unitVector, type ItemNumbers } from './standing';
import { statementIndexFor, type StatementIndex, type StatementStanding } from './statementIndex';

/** With fewer statements and eligible notes than this together, the numbers say too little to trust. */
const MIN_ITEMS = 5;
/** The most log notes one message is shown. */
const MAX_NOTES = 4;
/** The most log notes one message is shown when the vaults hold no page statements at all. */
const MAX_NOTES_WITHOUT_STATEMENTS = 6;
/** The longest a reply waits for the indexes and the query vector; the work carries on for the next message. */
const GATE_TIMEOUT_MS = 10_000;

/** A vault the gate may look into. */
export interface GateVault {
  /** The vault's namespace as recall names it. */
  namespace: string;
  dir: string;
  scan: NamespaceScan;
  /** The vault's meaning search; without it the vault is judged by neither statements nor notes. */
  embeddings: EmbeddingSubsystem | undefined;
}

/** A log note that passed both rules, best standing first in `MeaningGate.notes`. */
export interface ShownNote {
  id: string;
  standing: number;
}

/**
 * - `unavailable`: no meaning search is ready, so pages are read by name and the log is searched by words.
 * - `too_little`: fewer than five items to judge against, so the log is searched by words and meaning as before.
 * - `judged`: the message was measured; `open` says whether it is clearly about something remembered.
 */
export type MeaningGate =
  | { state: 'unavailable' }
  | { state: 'too_little' }
  | {
      state: 'judged';
      open: boolean;
      /** Every statement's standing for the message. */
      statements: StatementStanding[];
      /** The notes to show, best first; empty when the gate is closed. */
      notes: ShownNote[];
      /** The namespaces whose log was judged by meaning; any other vault's log is searched by words. */
      judgedNamespaces: ReadonlySet<string>;
      messageBest: number;
      bar: number;
    };

interface NoteVault {
  vault: GateVault;
  index: NoteIndex;
  /** The notes recall may show: indexed, not left out, and either unsorted or the person's own words. */
  eligible: string[];
}

function isPersonsOwn(text: string): boolean {
  return entryMetadata(text)[MEMORY_ORIGIN_METADATA_KEY] === USER_STATED_ORIGIN;
}

/**
 * Not sorted; or sorted onto no page and the person's own words. A note the sorter put on a page is spoken for by
 * its statements. A note the chat filed itself was never sorted, so it stays as a note that was not sorted yet.
 */
function isEligible({ outcome, text }: { outcome: HandledOutcome | undefined; text: string }): boolean {
  return outcome === undefined || outcome === 'chat' || (outcome === 'none' && isPersonsOwn(text));
}

async function eligibleNotes({
  vault,
  index,
  currentSessionId,
  now,
}: {
  vault: GateVault;
  index: NoteIndex;
  currentSessionId: string | undefined;
  now: Date;
}): Promise<string[]> {
  const handled = await readHandledNotes(vault.dir);
  const excluded = recallExcludedIds({ entries: vault.scan.entries, sessionId: currentSessionId, now });
  const indexed = new Set(index.numbersFor(vault.scan.entries.map(entry => entry.id)).map(({ id }) => id));
  return vault.scan.entries
    .filter(
      entry =>
        indexed.has(entry.id) &&
        !excluded.has(entry.id) &&
        isEligible({ outcome: handled.get(entry.id), text: entry.text }),
    )
    .map(entry => entry.id);
}

async function judge({
  message,
  vaults,
  currentSessionId,
  now,
}: {
  message: string;
  vaults: readonly GateVault[];
  currentSessionId?: string | undefined;
  now: Date;
}): Promise<MeaningGate> {
  const statementIndexes: StatementIndex[] = [];
  const noteVaults: NoteVault[] = [];
  let model: EmbeddingModel | undefined;
  for (const vault of vaults) {
    const embeddings = vault.embeddings;
    if (embeddings === undefined) {
      continue;
    }
    const statements = statementIndexFor({ vaultDir: vault.dir, model: embeddings.embeddingModel });
    if (await statements.refresh()) {
      statementIndexes.push(statements);
      model ??= embeddings.embeddingModel;
    }
    const store = embeddings.readyStore;
    if (store !== undefined) {
      const index = noteIndexFor({ vaultDir: vault.dir, model: embeddings.embeddingModel });
      await index.update({ entries: vault.scan.entries, store });
      noteVaults.push({
        vault,
        index,
        eligible: await eligibleNotes({ vault, index, currentSessionId, now }),
      });
      model ??= embeddings.embeddingModel;
    }
  }
  if (model === undefined || message.trim() === '') {
    return { state: 'unavailable' };
  }
  const statementCount = statementIndexes.reduce((sum, index) => sum + index.size, 0);
  const noteCount = noteVaults.reduce((sum, { eligible }) => sum + eligible.length, 0);
  if (statementCount + noteCount < MIN_ITEMS) {
    return { state: 'too_little' };
  }
  const [row] = await model.embedQueries([message]);
  if (row?.length !== EMBEDDING_DIMENSIONS) {
    return { state: 'unavailable' };
  }
  const query = unitVector(row);

  const statements = statementIndexes.flatMap(index => index.standings(query));
  const notes = noteVaults.flatMap(({ index, eligible }) => index.standings({ query, ids: eligible }));
  // Rule 2: the message must stand out against the best the ordinary messages reach over every statement and note.
  const best = emptyBest();
  for (const index of statementIndexes) {
    index.comparisonBest.forEach((standing, m) => {
      best[m] = Math.max(best[m] ?? -Infinity, standing);
    });
  }
  const eligibleNumbers: ItemNumbers[] = noteVaults.flatMap(({ index, eligible }) =>
    index.numbersFor(eligible).map(({ numbers }) => numbers),
  );
  raiseBest({ best, items: eligibleNumbers });
  const bar = percentileBar(best);
  const messageBest = [...statements, ...notes].reduce((top, { standing }) => Math.max(top, standing), -Infinity);
  const open = messageBest > bar;
  const shown = open
    ? notes
        .filter(({ standing }) => standing > STANDING_ABOVE)
        .sort((a, b) => b.standing - a.standing)
        .slice(0, statementCount === 0 ? MAX_NOTES_WITHOUT_STATEMENTS : MAX_NOTES)
    : [];
  return {
    state: 'judged',
    open,
    statements,
    notes: shown,
    judgedNamespaces: new Set(noteVaults.map(({ vault }) => vault.namespace)),
    messageBest,
    bar,
  };
}

/**
 * The gate for one message over the vaults a person may read. Never throws: a failure, or a wait longer than
 * ten seconds, answers `unavailable`, so the log is searched by words and no statement is found.
 */
export async function computeMeaningGate(input: {
  message: string;
  vaults: readonly GateVault[];
  currentSessionId?: string | undefined;
  now: Date;
}): Promise<MeaningGate> {
  try {
    return await withTimeout(judge(input), GATE_TIMEOUT_MS, 'memory meaning search');
  } catch {
    return { state: 'unavailable' };
  }
}
