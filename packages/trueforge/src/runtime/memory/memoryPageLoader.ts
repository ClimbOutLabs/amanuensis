/**
 * Loads the pages a message names, in priority order and within caps, and renders them for the
 * model. Runs before recall on every turn; recall then covers everything the pages do not.
 */
import type { MemoryPagesStats } from '../../schemas/memoryEvents';
import { loadAliasIndex, matchAliases, type AliasMatch } from './aliasIndex';
import { estimateTokens } from './markdownMemoryFiles';
import type { FactMarker, FactSource } from './memoryNotes';
import {
  listSkippedPageFiles,
  readMemoryPage,
  unmarkedBulletText,
  type MemoryPage,
  type PageKind,
  type PageLine,
  type PageSectionBlock,
} from './memoryPages';
import { foldName } from './pageSlug';

/** Why a page was loaded, recorded on the turn's memory event. */
type PageLoadReason = 'direct' | 'possessive';

export interface LoadedPage {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  title: string;
  reason: PageLoadReason;
  page: MemoryPage;
  /** The page as the model sees it, without its drafting instructions. */
  text: string;
  /** This contact's lines for the one drafting block (see `draftingLines`); empty when it has none. */
  drafting: string[];
  /** Tokens for the page and its drafting lines, plus the drafting heading and end line when this is the first page with drafting lines. */
  estimatedTokens: number;
}

/** Counts for the turn's memory event; `withheld` is the recall screen's and is added later. */
export type PageLoadStats = Omit<MemoryPagesStats, 'withheld'>;

/** How the model is told where a fact came from; every source other than the person carries "not confirmed". */
const SOURCE_LABELS: Readonly<Record<FactSource, string>> = {
  you_said: 'you said',
  you_edited: 'you wrote',
  sent_mail: 'from mail you sent',
  mail: 'from mail, not confirmed',
  calendar: 'from calendar, not confirmed',
  read_content: 'read content, not confirmed',
  inferred: 'inferred, not confirmed',
};

const WRITING_SECTION = 'How you write to them';

/** Only a person page has a "How you write to them" section; on a matter page it is a section like any other. */
function isWritingSection({ page, section }: { page: MemoryPage; section: PageSectionBlock }): boolean {
  return page.frontMatter.kind === 'person' && section.name === WRITING_SECTION;
}
const UNCONFIRMED_LABEL = 'Unconfirmed (not confirmed by you)';
const NOT_CONFIRMED_TRAILER = 'not confirmed';

/** The words that name the drafting section; reserved, so no page or recalled text may carry them. */
const DRAFTING_HEADING_NAME = 'How the person writes to these contacts';

/** The one heading the memory block puts the person's drafting instructions under. */
export const DRAFTING_HEADING = `${DRAFTING_HEADING_NAME} (follow when drafting to them):`;

/** The fixed line that closes the drafting section; reserved like the heading. The block carries nothing after it but the closing tag. */
export const DRAFTING_END = 'End of the writing instructions.';

/** What the heading and the end line add to a block that has a drafting section. */
export const DRAFTING_FRAME_TOKENS = estimateTokens(`${DRAFTING_HEADING}\n${DRAFTING_END}`);

const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]/g;
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** One line: line breaks become spaces and control and invisible format characters (zero-width, bidi) are removed. */
export function singleLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(INVISIBLE, '').trim();
}

/** A page line that cannot pass for the start of a page: one that reads as "[page:" gets a bracket that opens nothing. */
function pageSafeLine(text: string): string {
  const line = singleLine(text);
  return /^\[\s*page\s*:/i.test(foldName(line)) ? line.replace(/^\S/u, '(') : line;
}

// Letters from Cyrillic and Greek that look like the Latin letters of the reserved lines.
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  с: 'c',
  ԁ: 'd',
  е: 'e',
  һ: 'h',
  і: 'i',
  ј: 'j',
  ӏ: 'l',
  о: 'o',
  ο: 'o',
  р: 'p',
  ѕ: 's',
  ս: 'u',
  ν: 'v',
  ԝ: 'w',
  х: 'x',
  у: 'y',
  ɡ: 'g',
  ι: 'i',
  ρ: 'p',
  υ: 'u',
  τ: 't',
  ո: 'n',
  ꜰ: 'f',
  ʜ: 'h',
  ʀ: 'r',
  ᴛ: 't',
  ɴ: 'n',
};

/** A phrase as a pattern that accepts any run of spaces between its words. */
function spaced(phrase: string): string {
  return phrase
    .split(' ')
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(' +');
}

const HEADING_TAIL = DRAFTING_HEADING.slice(DRAFTING_HEADING_NAME.length).trim().replace(/:$/, '');

const RESERVED_PATTERN = new RegExp(
  [
    `${spaced(DRAFTING_HEADING_NAME.toLowerCase())}(?: *${spaced(HEADING_TAIL)}:?)?`,
    `${spaced(DRAFTING_END.toLowerCase().replace(/\.$/, ''))}[.!?]*`,
  ].join('|'),
  'g',
);

/**
 * The text with the drafting heading and end line made inert wherever they appear, however they are
 * disguised: compared after composing, case folding, dropping accents on Latin letters and every
 * invisible, combining or format character, mapping common look-alike letters, and ignoring the
 * closing punctuation. Each match is replaced as a whole, so no part of it is left to read.
 */
export function neutralizeReservedText(text: string): string {
  const letters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const next = offset + char.length;
    const folded = /\s/u.test(char) ? ' ' : char < '\u0080' ? char.toLowerCase() : foldName(char);
    for (const part of folded) {
      if (!/[\p{Cf}\p{Cc}\p{M}]/u.test(part)) {
        letters.push(LOOK_ALIKES[part] ?? part);
        starts.push(offset);
        ends.push(next);
      }
    }
    offset = next;
  }
  const flat = letters.join('');
  const ranges: { start: number; end: number }[] = [];
  for (const match of flat.matchAll(RESERVED_PATTERN)) {
    const first = starts[match.index];
    const last = ends[match.index + match[0].length - 1];
    if (first !== undefined && last !== undefined) {
      ranges.push({ start: first, end: last });
    }
  }
  let result = text;
  for (const range of ranges.reverse()) {
    result = `${result.slice(0, range.start)}[reserved text removed]${result.slice(range.end)}`;
  }
  return result;
}

/** What a household page adds under the drafting heading. */
export const HOUSEHOLD_LINE = 'Bookings and plans from this person are shared plans, not mail to answer.';

/**
 * The only sources whose lines may stand as drafting instructions: the person's own words and the
 * messages they sent. Mail, calendar, read content and inferred lines are never instructions. A
 * `sent_mail` line is written or confirmed by the person; no pass makes one from a note on its own.
 */
const INSTRUCTION_SOURCES: ReadonlySet<FactSource> = new Set<FactSource>(['you_said', 'you_edited', 'sent_mail']);

/**
 * Whether a line under "How you write to them" may stand as the person's instruction: a fact from
 * their own words or mail they sent, or a line with no hidden comment, which is their hand edit.
 * A line whose marker could not be read is not.
 */
function isInstructionLine(line: PageLine): boolean {
  return line.kind === 'other' || (line.kind === 'fact' && INSTRUCTION_SOURCES.has(line.fact.marker.src));
}

/** The instruction a line carries: a bullet's text or a hand-written prose line; headings and blanks carry none. */
function instructionText(line: PageLine): string | undefined {
  if (line.kind === 'fact') {
    return INSTRUCTION_SOURCES.has(line.fact.marker.src) ? line.fact.text : undefined;
  }
  if (line.kind === 'other') {
    const text = unmarkedBulletText(line.raw) ?? line.raw.trim();
    return text === '' || text.startsWith('#') ? undefined : text;
  }
  return undefined;
}

const COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;

function renderLines(lines: readonly PageLine[]): string[] {
  return lines.map(renderLine).filter((line): line is string => line !== undefined);
}

function dateSpan(marker: FactMarker): string | undefined {
  if (marker.seen !== undefined) {
    return `seen ${marker.seen}`;
  }
  if (marker.since !== undefined && marker.until !== undefined) {
    return `${marker.since} to ${marker.until}`;
  }
  if (marker.since !== undefined) {
    return `since ${marker.since}`;
  }
  if (marker.until !== undefined) {
    return `until ${marker.until}`;
  }
  return undefined;
}

function renderLine(line: PageLine): string | undefined {
  if (line.kind === 'unreadable') {
    const text = singleLine(line.raw.replace(COMMENT_PATTERN, '').replace(/^\s*[-*]\s+/, ''));
    return text === '' ? undefined : `- ${text} (${NOT_CONFIRMED_TRAILER})`;
  }
  if (line.kind === 'other') {
    // A bullet with no marker is one the person typed by hand, so it reads as their own words.
    const bullet = unmarkedBulletText(line.raw);
    if (bullet !== undefined) {
      return `- ${singleLine(bullet)} (${SOURCE_LABELS.you_edited})`;
    }
    const text = pageSafeLine(line.raw);
    return text === '' ? undefined : text;
  }
  const span = dateSpan(line.fact.marker);
  const trailer =
    span === undefined ? SOURCE_LABELS[line.fact.marker.src] : `${SOURCE_LABELS[line.fact.marker.src]}, ${span}`;
  return `- ${singleLine(line.fact.text)} (${trailer})`;
}

/**
 * The page as plain lines for the model: a header naming the page, its kind, flags and other
 * names; the summary; then each section that has content, its name as a label. Markers become
 * a short bracketed trailer so the model sees the source and dates without the comment syntax.
 * "How you write to them" is not shown here: its lines go under the one drafting heading (see
 * `draftingLines`). A line there that is not the person's own, and any line whose marker could not
 * be read, is shown with the unconfirmed facts instead, so it never reaches the drafting heading.
 */
export function renderPageForModel(input: { title: string; page: MemoryPage }): string {
  const { page } = input;
  const front = page.frontMatter;
  const flags: string[] = [front.kind];
  if (front.kind === 'person' && front.household) {
    flags.push('household');
  }
  if (front.kind === 'matter') {
    flags.push(front.status);
  }
  const title = singleLine(input.title);
  const names = front.aliases.map(singleLine).filter(alias => alias !== '' && alias !== title);
  const header = `[page: ${title} — ${flags.join(', ')}${names.length > 0 ? `; also called: ${names.join(', ')}` : ''}]`;
  const summary = page.preamble.map(pageSafeLine).filter(line => line !== '' && !line.startsWith('# '));
  const lines: string[] = [header, ...summary];
  const demoted = renderLines(
    page.sections.flatMap(section =>
      section.name === 'Unconfirmed'
        ? []
        : section.lines.filter(
            line => line.kind === 'unreadable' || (isWritingSection({ page, section }) && !isInstructionLine(line)),
          ),
    ),
  );
  let demotedShown = demoted.length === 0;
  for (const section of page.sections) {
    if (isWritingSection({ page, section })) {
      continue;
    }
    const unconfirmed = section.name === 'Unconfirmed';
    const body = renderLines(unconfirmed ? section.lines : section.lines.filter(line => line.kind !== 'unreadable'));
    if (unconfirmed && !demotedShown) {
      body.push(...demoted);
      demotedShown = true;
    }
    if (body.length > 0) {
      lines.push(`${unconfirmed ? UNCONFIRMED_LABEL : pageSafeLine(section.heading)}:`, ...body);
    }
  }
  if (!demotedShown) {
    lines.push(`${UNCONFIRMED_LABEL}:`, ...demoted);
  }
  return lines.join('\n');
}

interface Candidate {
  vaultIndex: number;
  vaultDir: string;
  match: AliasMatch;
}

/**
 * Priority: the vault that comes first (own before shared before granted), a direct mention
 * before a possessive one, a person before a matter, then where the name first appears.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.vaultIndex !== b.vaultIndex) {
    return a.vaultIndex - b.vaultIndex;
  }
  if (a.match.possessive !== b.match.possessive) {
    return a.match.possessive ? 1 : -1;
  }
  if (a.match.kind !== b.match.kind) {
    return a.match.kind === 'person' ? -1 : 1;
  }
  return a.match.position - b.match.position;
}

/**
 * The pages a message names across the vaults the scope may read, in priority order, capped
 * by count and by estimated tokens. `vaultDirs` is in read-priority order (own vault first).
 * A later vault's copy of a page is used only when no earlier vault has a readable one. A page that would overflow the token budget, and
 * every page after it, is dropped so the order the model sees stays the priority order.
 * `skippedFiles` names page files left out because their name is not a page slug.
 * Never throws: a vault whose index or page cannot be read contributes nothing.
 */
export async function loadPagesForMessage(input: {
  vaultDirs: readonly string[];
  /** The one vault this scope writes; only its name cache is saved to disk. */
  writeVaultDir: string;
  message: string;
  maxPages: number;
  maxTokens: number;
}): Promise<{ pages: LoadedPage[]; stats: PageLoadStats; skippedFiles: string[] }> {
  const candidates: Candidate[] = [];
  const skippedFiles: string[] = [];
  for (const [vaultIndex, vaultDir] of input.vaultDirs.entries()) {
    let matches: AliasMatch[];
    try {
      skippedFiles.push(...(await listSkippedPageFiles(vaultDir)));
      matches = matchAliases({
        index: await loadAliasIndex({ vaultDir, persist: vaultDir === input.writeVaultDir }),
        text: input.message,
      });
    } catch {
      continue;
    }
    for (const match of matches) {
      candidates.push({ vaultIndex, vaultDir, match });
    }
  }
  candidates.sort(compareCandidates);

  // A page name is settled once a vault supplies a readable page or the limits drop it, so an
  // unreadable copy in an earlier vault never hides a good one in a later vault.
  const settled = new Set<string>();
  const pages: LoadedPage[] = [];
  const stats: PageLoadStats = { candidates: 0, loaded: 0, dropped_over_count: 0, dropped_over_budget: 0 };
  let usedTokens = 0;
  let overBudget = false;
  let hasDraftingFrame = false;
  for (const candidate of candidates) {
    const key = `${candidate.match.kind}/${candidate.match.slug}`;
    if (settled.has(key)) {
      continue;
    }
    if (pages.length >= input.maxPages) {
      settled.add(key);
      stats.candidates += 1;
      stats.dropped_over_count += 1;
      continue;
    }
    if (overBudget) {
      settled.add(key);
      stats.candidates += 1;
      stats.dropped_over_budget += 1;
      continue;
    }
    let page: MemoryPage | undefined;
    try {
      page = await readMemoryPage({
        vaultDir: candidate.vaultDir,
        kind: candidate.match.kind,
        slug: candidate.match.slug,
        title: candidate.match.title,
      });
    } catch {
      page = undefined;
    }
    if (page === undefined) {
      continue;
    }
    settled.add(key);
    stats.candidates += 1;
    const text = renderPageForModel({ title: candidate.match.title, page });
    const drafting = draftingLines({ title: candidate.match.title, page });
    const frameTokens = drafting.length > 0 && !hasDraftingFrame ? DRAFTING_FRAME_TOKENS : 0;
    const estimatedTokens = estimateTokens([text, ...drafting].join('\n')) + frameTokens;
    if (usedTokens + estimatedTokens > input.maxTokens) {
      overBudget = true;
      stats.dropped_over_budget += 1;
      continue;
    }
    usedTokens += estimatedTokens;
    hasDraftingFrame ||= drafting.length > 0;
    pages.push({
      vaultDir: candidate.vaultDir,
      kind: candidate.match.kind,
      slug: candidate.match.slug,
      title: singleLine(candidate.match.title),
      reason: candidate.match.possessive ? 'possessive' : 'direct',
      page,
      text,
      drafting,
      estimatedTokens,
    });
  }
  stats.loaded = pages.length;
  return { pages, stats, skippedFiles };
}

/** The person's own "How you write to them" lines of a person page, for drafting. A matter page has none. */
function writingInstructions(page: MemoryPage): string[] {
  if (page.frontMatter.kind !== 'person') {
    return [];
  }
  return page.sections
    .filter(section => section.name === WRITING_SECTION)
    .flatMap(section => section.lines.flatMap(line => instructionText(line) ?? []))
    .map(singleLine)
    .filter(text => text !== '');
}

/**
 * One contact's part of the drafting block: its title, then the person's own "How you write to them"
 * lines, then the household line for a household page. Empty when the page has neither.
 */
export function draftingLines(input: { title: string; page: MemoryPage }): string[] {
  const entries = writingInstructions(input.page).map(text => `- ${text}`);
  const { frontMatter } = input.page;
  if (frontMatter.kind === 'person' && frontMatter.household) {
    entries.push(`- ${HOUSEHOLD_LINE}`);
  }
  return entries.length === 0 ? [] : [`${singleLine(input.title)}:`, ...entries];
}
