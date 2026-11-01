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
} from './memoryPages';

/** Why a page was loaded, recorded on the turn's memory event. */
export type PageLoadReason = 'direct' | 'possessive';

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
  estimatedTokens: number;
}

/** Counts for the turn's memory event; `withheld` is the recall screen's and is added later. */
export type PageLoadStats = Omit<MemoryPagesStats, 'withheld'>;

/** How the model is told where a fact came from. */
const SOURCE_LABELS: Readonly<Record<FactSource, string>> = {
  you_said: 'you said',
  you_edited: 'you wrote',
  sent_mail: 'from mail you sent',
  mail: 'from mail',
  calendar: 'from calendar',
  read_content: 'read content, not confirmed',
  inferred: 'inferred, not confirmed',
};

const WRITING_SECTION = 'How you write to them';
const UNCONFIRMED_LABEL = 'Unconfirmed (not confirmed by you)';
const NOT_CONFIRMED_TRAILER = 'not confirmed';

/** The one heading the memory block puts the person's drafting instructions under. */
export const DRAFTING_HEADING = 'How the person writes to these contacts (follow when drafting to them):';

/** What a household page adds under the drafting heading. */
export const HOUSEHOLD_LINE = 'Bookings and plans from this person are shared plans, not mail to answer.';

/**
 * The only sources whose lines may stand as drafting instructions: the person's own words and the
 * messages they sent. Mail, calendar, read content and inferred lines are never instructions.
 */
const INSTRUCTION_SOURCES: ReadonlySet<FactSource> = new Set<FactSource>(['you_said', 'you_edited', 'sent_mail']);

/** A bullet with no hidden comment is the person's own hand edit; one with a broken marker is not. */
function isInstructionLine(line: PageLine): boolean {
  return line.kind === 'other' || (line.kind === 'fact' && INSTRUCTION_SOURCES.has(line.fact.marker.src));
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
    const text = line.raw
      .replace(COMMENT_PATTERN, '')
      .replace(/^\s*[-*]\s+/, '')
      .trim();
    return text === '' ? undefined : `- ${text} (${NOT_CONFIRMED_TRAILER})`;
  }
  if (line.kind === 'other') {
    // A bullet with no marker is one the person typed by hand, so it reads as their own words.
    const bullet = unmarkedBulletText(line.raw);
    if (bullet !== undefined) {
      return `- ${bullet} (${SOURCE_LABELS.you_edited})`;
    }
    const text = line.raw.trim();
    return text === '' ? undefined : text;
  }
  const span = dateSpan(line.fact.marker);
  const trailer =
    span === undefined ? SOURCE_LABELS[line.fact.marker.src] : `${SOURCE_LABELS[line.fact.marker.src]}, ${span}`;
  return `- ${line.fact.text} (${trailer})`;
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
  const names = front.aliases.filter(alias => alias !== input.title);
  const header = `[page: ${input.title} — ${flags.join(', ')}${names.length > 0 ? `; also called: ${names.join(', ')}` : ''}]`;
  const summary = page.preamble.map(line => line.trim()).filter(line => line !== '' && !line.startsWith('# '));
  const lines: string[] = [header, ...summary];
  const demoted = renderLines(
    page.sections.flatMap(section =>
      section.name === 'Unconfirmed'
        ? []
        : section.lines.filter(
            line => line.kind === 'unreadable' || (section.name === WRITING_SECTION && !isInstructionLine(line)),
          ),
    ),
  );
  let demotedShown = demoted.length === 0;
  for (const section of page.sections) {
    if (section.name === WRITING_SECTION) {
      continue;
    }
    const unconfirmed = section.name === 'Unconfirmed';
    const body = renderLines(unconfirmed ? section.lines : section.lines.filter(line => line.kind !== 'unreadable'));
    if (unconfirmed && !demotedShown) {
      body.push(...demoted);
      demotedShown = true;
    }
    if (body.length > 0) {
      lines.push(`${unconfirmed ? UNCONFIRMED_LABEL : section.heading.trim()}:`, ...body);
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
 * The same slug in a later vault is skipped. A page that would overflow the token budget, and
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

  const seen = new Set<string>();
  const pages: LoadedPage[] = [];
  const stats: PageLoadStats = { candidates: 0, loaded: 0, dropped_over_count: 0, dropped_over_budget: 0 };
  let usedTokens = 0;
  let overBudget = false;
  for (const candidate of candidates) {
    const key = `${candidate.match.kind}/${candidate.match.slug}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    stats.candidates += 1;
    if (pages.length >= input.maxPages) {
      stats.dropped_over_count += 1;
      continue;
    }
    if (overBudget) {
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
    const text = renderPageForModel({ title: candidate.match.title, page });
    const drafting = draftingLines({ title: candidate.match.title, page });
    const estimatedTokens = estimateTokens([text, ...drafting].join('\n'));
    if (usedTokens + estimatedTokens > input.maxTokens) {
      overBudget = true;
      stats.dropped_over_budget += 1;
      continue;
    }
    usedTokens += estimatedTokens;
    pages.push({
      vaultDir: candidate.vaultDir,
      kind: candidate.match.kind,
      slug: candidate.match.slug,
      title: candidate.match.title,
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

/** The "How you write to them" lines of a loaded person page, as instructions for drafting. */
export function writingInstructions(page: MemoryPage): string[] {
  return page.sections
    .filter(section => section.name === WRITING_SECTION)
    .flatMap(section => section.lines.filter(isInstructionLine))
    .flatMap(line => {
      const text = line.kind === 'fact' ? line.fact.text : unmarkedBulletText(line.raw);
      return text === undefined ? [] : [text];
    });
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
  return entries.length === 0 ? [] : [`${input.title}:`, ...entries];
}
