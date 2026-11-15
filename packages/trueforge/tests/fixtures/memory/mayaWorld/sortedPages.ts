import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';

import type { FactMarker, FactSource } from '../../../../src/runtime/memory/memoryNotes';
import { USER_STATED_ORIGIN } from '../../../../src/runtime/memory/memoryOrigin';
import {
  PageSectionSchema,
  pagePath,
  type PageKind,
  type PageSection,
} from '../../../../src/runtime/memory/memoryPages';
import { pageSlug } from '../../../../src/runtime/memory/pageSlug';
import { MAYA_ENTRIES } from './entries';
import { MAYA_EVENTS } from './events';
import { MAYA_PAGES, mayaDate, type MayaPage } from './pages';
import type { MayaEntry, MayaEvent } from './schema';

/** One page as a file: where it goes and what it holds. */
export interface SortedPage {
  kind: PageKind;
  slug: string;
  content: string;
}

type Marker = Omit<FactMarker, 'kind'>;

/** One bullet. A bullet with no marker is a line the person typed by hand. */
interface Statement {
  text: string;
  marker: Marker | undefined;
}

interface PageState {
  page: MayaPage;
  sections: Map<PageSection, Statement[]>;
}

type Decision = MayaEntry['expected'][number];

const EARLIER: PageSection = 'Earlier';
const UNCONFIRMED: PageSection = 'Unconfirmed';

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function factId({ entryId, index }: { entryId: string; index: number }): string {
  return `f_${createHash('sha256')
    .update(`${entryId}:${String(index)}`)
    .digest('hex')
    .slice(0, 10)}`;
}

function sourceOf(entry: MayaEntry): FactSource {
  if (entry.origin === USER_STATED_ORIGIN) {
    return 'you_said';
  }
  switch (entry.note_source) {
    case 'email':
      return 'mail';
    case 'calendar':
      return 'calendar';
    case 'sent_mail':
      return 'sent_mail';
    case 'web':
    case 'attachment':
    case 'other':
      return 'read_content';
    default:
      throw new Error(`Entry ${entry.id} is a ${entry.note_source} note, which never becomes a statement on a page.`);
  }
}

function markerOf({
  id,
  src,
  since,
  until,
  seen,
}: {
  id: string;
  src: FactSource;
  since?: string | undefined;
  until?: string | undefined;
  seen?: string | undefined;
}): Marker {
  return {
    id,
    src,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(seen === undefined ? {} : { seen }),
  };
}

function statementsOf({ state, section }: { state: PageState; section: PageSection }): Statement[] {
  const existing = state.sections.get(section);
  if (existing !== undefined) {
    return existing;
  }
  const created: Statement[] = [];
  state.sections.set(section, created);
  return created;
}

function findCurrent({
  state,
  text,
}: {
  state: PageState;
  text: string;
}): { section: PageSection; statement: Statement } | undefined {
  for (const section of PageSectionSchema.options) {
    if (section === EARLIER) {
      continue;
    }
    const statement = state.sections.get(section)?.find(candidate => normalized(candidate.text) === normalized(text));
    if (statement !== undefined) {
      return { section, statement };
    }
  }
  return undefined;
}

/** Moves a current statement to `Earlier` with the day it stopped being true. */
function retire({
  state,
  found,
  until,
}: {
  state: PageState;
  found: { section: PageSection; statement: Statement };
  until: string;
}): void {
  const { marker } = found.statement;
  if (marker === undefined) {
    throw new Error(`The statement "${found.statement.text}" was typed by hand and has no marker to end.`);
  }
  const from = statementsOf({ state, section: found.section });
  from.splice(from.indexOf(found.statement), 1);
  statementsOf({ state, section: EARLIER }).push({ text: found.statement.text, marker: { ...marker, until } });
}

function applyDecision({
  entry,
  decision,
  index,
  states,
}: {
  entry: MayaEntry;
  decision: Decision;
  index: number;
  states: Map<string, PageState>;
}): void {
  if (decision.decision === 'ignore') {
    return;
  }
  const state = states.get(decision.about);
  if (state === undefined) {
    throw new Error(`Entry ${entry.id} is about ${decision.about}, which is not a page in Maya's world.`);
  }
  const id = factId({ entryId: entry.id, index });
  const missing = (text: string): Error =>
    new Error(`Entry ${entry.id}: the page ${decision.about} holds no current statement "${text}".`);
  switch (decision.decision) {
    case 'new':
      statementsOf({ state, section: decision.section }).push({
        text: decision.text,
        marker: markerOf({
          id,
          src: sourceOf(entry),
          since: decision.since ?? mayaDate(entry.day),
          until: decision.until,
        }),
      });
      return;
    case 'same':
      if (findCurrent({ state, text: decision.matches_text }) === undefined) {
        throw missing(decision.matches_text);
      }
      return;
    case 'changed': {
      const found = findCurrent({ state, text: decision.old_text });
      if (found === undefined) {
        throw missing(decision.old_text);
      }
      retire({ state, found, until: decision.until_old });
      statementsOf({ state, section: found.section }).push({
        text: decision.new_text,
        marker: markerOf({ id, src: sourceOf(entry), since: decision.since_new }),
      });
      return;
    }
    case 'ended': {
      const found = findCurrent({ state, text: decision.old_text });
      if (found === undefined) {
        throw missing(decision.old_text);
      }
      retire({ state, found, until: decision.until });
      return;
    }
    case 'unconfirmed':
      statementsOf({ state, section: UNCONFIRMED }).push({
        text: decision.text,
        marker: markerOf({ id, src: sourceOf(entry), seen: decision.seen }),
      });
      return;
  }
}

function applyHandEdit({ event, states }: { event: MayaEvent; states: Map<string, PageState> }): void {
  const state = states.get(event.about);
  if (state === undefined) {
    throw new Error(
      `The hand edit of day ${String(event.day)} is about ${event.about}, which is not a page in Maya's world.`,
    );
  }
  const found = event.before_line === null ? undefined : findCurrent({ state, text: event.before_line });
  if (found === undefined) {
    statementsOf({ state, section: 'Now' }).push({ text: event.after_line, marker: undefined });
    return;
  }
  // The person edits the words and leaves the hidden comment alone.
  found.statement.text = event.after_line;
}

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord({ text, word }: { text: string; word: string }): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Every name of the page, then each role word the person has said about someone it still describes. */
function aliasesOf(state: PageState): string[] {
  const standing = PageSectionSchema.options
    .filter(section => section !== UNCONFIRMED && section !== EARLIER)
    .flatMap(section => state.sections.get(section) ?? [])
    .filter(statement => statement.marker?.src === 'you_said');
  return [
    ...state.page.names,
    ...state.page.roles.filter(role => standing.some(statement => hasWord({ text: statement.text, word: role }))),
  ];
}

function markerComment(marker: Marker): string {
  const parts = [
    `id=${marker.id}`,
    `src=${marker.src}`,
    ...(marker.since === undefined ? [] : [`since=${marker.since}`]),
    ...(marker.until === undefined ? [] : [`until=${marker.until}`]),
    ...(marker.seen === undefined ? [] : [`seen=${marker.seen}`]),
  ];
  return `<!-- fact: ${parts.join(' ')} -->`;
}

function renderPage(state: PageState): string | undefined {
  const blocks = PageSectionSchema.options.flatMap(section => {
    const statements = state.sections.get(section) ?? [];
    return statements.length === 0
      ? []
      : [
          [
            `## ${section}`,
            ...statements.map(({ text, marker }) =>
              marker === undefined ? `- ${text}` : `- ${text} ${markerComment(marker)}`,
            ),
          ].join('\n'),
        ];
  });
  if (blocks.length === 0) {
    return undefined;
  }
  const aliases = aliasesOf(state);
  const front = stringify({
    kind: state.page.kind,
    title: state.page.title,
    ...(aliases.length === 0 ? {} : { aliases }),
  });
  return `---\n${front}---\n# ${state.page.title}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * The pages a perfect sorter would hold at the end of `throughDay`, built from the expected decision of
 * every entry and the hand edits. Takes the entries and events so a test can feed it a small world.
 */
export function sortedPagesFrom({
  entries,
  events,
  throughDay,
}: {
  entries: readonly MayaEntry[];
  events: readonly MayaEvent[];
  throughDay: number;
}): SortedPage[] {
  const states = new Map<string, PageState>(
    Object.values(MAYA_PAGES).map(page => [pageSlug(page.title), { page, sections: new Map() }]),
  );
  for (let day = 1; day <= throughDay; day += 1) {
    const ofDay = entries.filter(entry => entry.day === day).sort((a, b) => a.id.localeCompare(b.id));
    for (const entry of ofDay) {
      for (const [index, decision] of entry.expected.entries()) {
        applyDecision({ entry, decision, index, states });
      }
    }
    for (const event of events.filter(candidate => candidate.day === day)) {
      applyHandEdit({ event, states });
    }
  }
  return [...states.entries()].flatMap(([slug, state]) => {
    const content = renderPage(state);
    return content === undefined ? [] : [{ kind: state.page.kind, slug, content }];
  });
}

/** The pages a perfect sorter would hold at the end of `throughDay` of Maya's world. */
export function mayaSortedPages(throughDay: number): SortedPage[] {
  return sortedPagesFrom({ entries: MAYA_ENTRIES, events: MAYA_EVENTS, throughDay });
}

/** Writes every sorted page for `throughDay` into the vault folder, replacing what is there. */
export async function writeMayaSortedPages({
  vaultDir,
  throughDay,
}: {
  vaultDir: string;
  throughDay: number;
}): Promise<void> {
  for (const { kind, slug, content } of mayaSortedPages(throughDay)) {
    const file = pagePath({ vaultDir, kind, slug });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
}
