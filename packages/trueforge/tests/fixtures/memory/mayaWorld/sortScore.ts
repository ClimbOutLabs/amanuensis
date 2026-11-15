import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { entryMetadata, entryRecallText, formatRetainEntry } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { pagePath, readMemoryPage, type PageListing } from '../../../../src/runtime/memory/memoryPages';
import type { SortDecision } from '../../../../src/runtime/memory/pageSortDecisions';
import { shownStatements } from '../../../../src/runtime/memory/pageSortPrompt';
import type { SortNote, SortResult } from '../../../../src/runtime/memory/pageSorter';
import { sameText } from '../../../../src/runtime/memory/pageStatements';
import type { ExpectedDecision } from '../decisionSchema';
import { retainItemOf } from './buildVault';
import { MAYA_ENTRIES, MAYA_STORY_IDS } from './entries';
import { MAYA_EVENTS } from './events';
import { mayaDate, mayaPageBySlug } from './pages';
import type { MayaEntry } from './schema';
import { sortedPagesFrom } from './sortedPages';

/** What a sorter is given for one entry: the vault of pages a perfect sorter would hold, and the note. */
export interface SortCase {
  vaultDir: string;
  note: SortNote;
  entry: MayaEntry;
  /** The pages the entry's expected decisions are about. A fake stands in with them for the search by meaning, which no test can run. */
  expectedPages: PageListing[];
}

/** A sorter-shaped function: sorts one note against the pages in its vault. */
export type SorterUnderTest = (input: SortCase) => Promise<SortResult>;

/** The decision kinds, in the order a score lists them. */
export const DECISION_KINDS = ['new', 'same', 'changed', 'ended', 'unconfirmed', 'ignore'] as const;
type DecisionKind = (typeof DECISION_KINDS)[number];

/** What a decision has to match to be right: its kind, its page and, for an existing statement, which one. */
function keyOf({
  kind,
  about,
  statementId,
}: {
  kind: DecisionKind;
  about: string;
  statementId?: string | undefined;
}): string {
  return [kind, about, statementId].filter(part => part !== undefined).join('|');
}

/**
 * The id the prompt would show for the current statement on a page that says this text. Throws when the page
 * holds none, since the story then names something that is not there.
 */
export async function statementIdFor({
  vaultDir,
  about,
  text,
}: {
  vaultDir: string;
  about: string;
  text: string;
}): Promise<string> {
  const listing = mayaPageBySlug(about);
  const page = listing === undefined ? undefined : await readMemoryPage({ vaultDir, kind: listing.kind, slug: about });
  const found =
    page === undefined
      ? undefined
      : shownStatements(page).find(statement => statement.id !== undefined && sameText({ a: statement.text, b: text }));
  if (found?.id === undefined) {
    throw new Error(`The page ${about} holds no current statement "${text}".`);
  }
  return found.id;
}

interface ExpectedKey {
  kind: DecisionKind;
  key: string;
}

async function expectedKeys({
  vaultDir,
  expected,
}: {
  vaultDir: string;
  expected: readonly ExpectedDecision[];
}): Promise<ExpectedKey[]> {
  const keys: ExpectedKey[] = [];
  for (const decision of expected) {
    switch (decision.decision) {
      case 'ignore':
        break;
      case 'new':
      case 'unconfirmed':
        keys.push({ kind: decision.decision, key: keyOf({ kind: decision.decision, about: decision.about }) });
        break;
      case 'same': {
        const statementId = await statementIdFor({ vaultDir, about: decision.about, text: decision.matches_text });
        keys.push({ kind: 'same', key: keyOf({ kind: 'same', about: decision.about, statementId }) });
        break;
      }
      case 'changed':
      case 'ended': {
        const statementId = await statementIdFor({ vaultDir, about: decision.about, text: decision.old_text });
        keys.push({
          kind: decision.decision,
          key: keyOf({ kind: decision.decision, about: decision.about, statementId }),
        });
        break;
      }
    }
  }
  return keys;
}

function gotKeys(decisions: readonly SortDecision[]): string[] {
  return decisions
    .flatMap((decision): string[] => {
      switch (decision.decision) {
        case 'ignore':
          return [];
        case 'new':
        case 'unconfirmed':
          return [keyOf({ kind: decision.decision, about: decision.about })];
        default:
          return [keyOf({ kind: decision.decision, about: decision.about, statementId: decision.statement_id })];
      }
    })
    .sort();
}

/** Writes the pages a perfect sorter holds just before this entry, in a fresh vault folder. */
async function writePagesBefore({ vaultDir, entry }: { vaultDir: string; entry: MayaEntry }): Promise<void> {
  const position = MAYA_ENTRIES.indexOf(entry);
  const pages = sortedPagesFrom({
    entries: MAYA_ENTRIES.slice(0, position),
    // A hand edit lands after the day's entries, so it is in the vault from the next day on.
    events: MAYA_EVENTS.filter(event => event.day < entry.day),
    throughDay: entry.day,
  });
  for (const { kind, slug, content } of pages) {
    const file = pagePath({ vaultDir, kind, slug });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
}

function expectedPagesOf(entry: MayaEntry): PageListing[] {
  const pages = new Map<string, PageListing>();
  for (const decision of entry.expected) {
    const page = decision.decision === 'ignore' ? undefined : mayaPageBySlug(decision.about);
    if (decision.decision !== 'ignore' && page !== undefined) {
      pages.set(decision.about, { kind: page.kind, slug: decision.about });
    }
  }
  return [...pages.values()];
}

function noteOf(entry: MayaEntry): SortNote {
  const stored = formatRetainEntry(retainItemOf(entry));
  const position = MAYA_ENTRIES.filter(candidate => candidate.day === entry.day).indexOf(entry);
  return {
    id: `md:maya:${mayaDate(entry.day)}.md#${String(position)}`,
    text: entryRecallText(stored),
    day: mayaDate(entry.day),
    metadata: entryMetadata(stored),
  };
}

/** One entry the sorter got wrong. The note is cut to its first 80 characters. */
export interface SortMiss {
  entryId: string;
  note: string;
  expected: string[];
  got: string[];
  /** Why the sorter produced no decisions, when it did not. */
  reason?: string | undefined;
}

export interface SortScore {
  total: number;
  right: number;
  /** For each decision kind: how many were expected and how many of those the sorter made. Entries with nothing to put on a page count as `ignore`. */
  byKind: Record<DecisionKind, { expected: number; right: number }>;
  misses: SortMiss[];
}

/** The hand-written entries of the story, in order. */
export const MAYA_STORY_ENTRIES: readonly MayaEntry[] = MAYA_ENTRIES.filter(entry => MAYA_STORY_IDS.has(entry.id));

/**
 * Runs a sorter over entries of Maya's world in order. Before each entry the vault holds the pages a perfect
 * sorter would have made from the earlier entries. An entry is right when the sorter's decisions match the
 * expected ones in kind and page and, for an existing statement, in which statement. Text of new statements is
 * not compared.
 */
export async function scoreSorter({
  sorter,
  entries = MAYA_STORY_ENTRIES,
}: {
  sorter: SorterUnderTest;
  entries?: readonly MayaEntry[];
}): Promise<SortScore> {
  const byKind: SortScore['byKind'] = {
    new: { expected: 0, right: 0 },
    same: { expected: 0, right: 0 },
    changed: { expected: 0, right: 0 },
    ended: { expected: 0, right: 0 },
    unconfirmed: { expected: 0, right: 0 },
    ignore: { expected: 0, right: 0 },
  };
  const misses: SortMiss[] = [];
  let right = 0;
  for (const entry of entries) {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'sort-score-'));
    try {
      await writePagesBefore({ vaultDir, entry });
      const wanted = await expectedKeys({ vaultDir, expected: entry.expected });
      const expected = wanted.map(({ key }) => key).sort();
      const result = await sorter({ vaultDir, note: noteOf(entry), entry, expectedPages: expectedPagesOf(entry) });
      const got = result.status === 'sorted' ? gotKeys(result.decisions) : [];
      const isRight = expected.length === got.length && expected.every((key, i) => key === got[i]);
      if (isRight) {
        right += 1;
      } else {
        misses.push({
          entryId: entry.id,
          note: entry.content.slice(0, 80),
          expected,
          got,
          ...(result.status === 'sorted' ? {} : { reason: result.status === 'off' ? 'off' : result.reason }),
        });
      }
      if (wanted.length === 0) {
        byKind.ignore.expected += 1;
        byKind.ignore.right += got.length === 0 ? 1 : 0;
      }
      const remaining = [...got];
      for (const { kind, key } of wanted) {
        byKind[kind].expected += 1;
        const at = remaining.indexOf(key);
        if (at !== -1) {
          remaining.splice(at, 1);
          byKind[kind].right += 1;
        }
      }
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
    }
  }
  return { total: entries.length, right, byKind, misses };
}

/** `N of M right` and one line per decision kind. */
export function describeScore(score: SortScore): string {
  return [
    `${String(score.right)} of ${String(score.total)} right`,
    ...DECISION_KINDS.map(
      kind => `  ${kind}: ${String(score.byKind[kind].right)} of ${String(score.byKind[kind].expected)} right`,
    ),
  ].join('\n');
}
