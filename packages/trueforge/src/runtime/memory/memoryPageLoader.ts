/**
 * Loads the pages a message names, in priority order and within caps, and renders them for the
 * model. Runs before recall on every turn; recall then covers everything the pages do not.
 */
import { loadAliasIndex, matchAliases, type AliasMatch } from './aliasIndex';
import { estimateTokens } from './markdownMemoryFiles';
import type { FactMarker, FactSource } from './memoryNotes';
import {
  PAGE_SECTIONS,
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
  /** The page as the model sees it. */
  text: string;
  estimatedTokens: number;
}

/** Counts for the turn's memory event. Keys are stored, so snake_case. */
export interface PageLoadStats {
  candidates: number;
  loaded: number;
  dropped_over_count: number;
  dropped_over_budget: number;
}

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

/**
 * The only sources whose lines may stand as drafting instructions: the person's own words and the
 * messages they sent. Mail, calendar, read content and inferred lines are never instructions.
 */
const INSTRUCTION_SOURCES: ReadonlySet<FactSource> = new Set<FactSource>(['you_said', 'you_edited', 'sent_mail']);

/** A marker-less bullet is the person's own hand edit, so it counts as `you_edited`. */
function isInstructionLine(line: PageLine): boolean {
  return line.kind === 'other' || INSTRUCTION_SOURCES.has(line.fact.marker.src);
}

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
  // A line under "How you write to them" that the person did not write or send is not an instruction:
  // it is shown with the unconfirmed facts instead, so read content never reaches the drafting heading.
  const demoted = renderLines(
    page.sections
      .filter(section => section.name === WRITING_SECTION)
      .flatMap(section => section.lines.filter(line => !isInstructionLine(line))),
  );
  let demotedShown = demoted.length === 0;
  for (const section of page.sections) {
    const writing = section.name === WRITING_SECTION;
    const unconfirmed = section.name === 'Unconfirmed';
    const body = renderLines(writing ? section.lines.filter(isInstructionLine) : section.lines);
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

/** Section order, so the model-facing text and any caller that sorts facts agree. */
export const PAGE_SECTION_ORDER: readonly string[] = PAGE_SECTIONS;

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
 * Never throws: a vault whose index or page cannot be read contributes nothing.
 */
export async function loadPagesForMessage(input: {
  vaultDirs: readonly string[];
  message: string;
  maxPages: number;
  maxTokens: number;
}): Promise<{ pages: LoadedPage[]; stats: PageLoadStats }> {
  const candidates: Candidate[] = [];
  for (const [vaultIndex, vaultDir] of input.vaultDirs.entries()) {
    let matches: AliasMatch[];
    try {
      matches = matchAliases({ index: await loadAliasIndex({ vaultDir }), text: input.message });
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
    const estimatedTokens = estimateTokens(text);
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
      estimatedTokens,
    });
  }
  stats.loaded = pages.length;
  return { pages, stats };
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
