/**
 * Pages: one Markdown file per person (`people/<slug>.md`) or matter (`matters/<slug>.md`)
 * inside a vault, read and written by the nightly pass, Settings, and the chat tools.
 *
 * Canonical owner of the page format. A parsed page keeps every line's raw text, and a line
 * is rendered from its raw text unless something changed it, so parse then render returns the
 * exact bytes for any input, however oddly shaped. Only lines a change touched are rendered
 * canonically.
 */
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify, type ToStringOptions } from 'yaml';
import { z } from 'zod';

import type { FactDate, FactId, FactMarker, FactSource } from './memoryNotes';
import { FactMarkerSchema, formatMarker, splitFactMarker } from './memoryNotes';
import { isPageSlug, pageSlug } from './pageSlug';

export const PAGE_KINDS = ['person', 'matter'] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKindSchema>;

/** The vault folder each kind of page lives in. */
export const PAGE_FOLDERS: Readonly<Record<PageKind, string>> = { person: 'people', matter: 'matters' };

/** The sections a page may have, in the order a fresh page lists them. */
export const PAGE_SECTIONS = ['How you write to them', 'Now', 'Decided', 'Open', 'Unconfirmed', 'Earlier'] as const;
export const PageSectionSchema = z.enum(PAGE_SECTIONS);
export type PageSection = z.infer<typeof PageSectionSchema>;

/** Which sections a fresh page of each kind starts with. */
export const PAGE_SECTIONS_BY_KIND: Readonly<Record<PageKind, readonly PageSection[]>> = {
  person: ['How you write to them', 'Now', 'Unconfirmed', 'Earlier'],
  matter: ['Now', 'Decided', 'Open', 'Unconfirmed', 'Earlier'],
};

export const MatterStatusSchema = z.enum(['active', 'done']);
export type MatterStatus = z.infer<typeof MatterStatusSchema>;

const pageFrontMatterBase = {
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
};

export const PersonFrontMatterSchema = z.object({
  kind: z.literal('person'),
  ...pageFrontMatterBase,
  household: z.boolean().default(false),
});

export const MatterFrontMatterSchema = z.object({
  kind: z.literal('matter'),
  ...pageFrontMatterBase,
  status: MatterStatusSchema.default('active'),
});

/** The YAML block at the top of a page. Keys outside this schema ride along in `MemoryPage.extraFrontMatter`. */
export const PageFrontMatterSchema = z.discriminatedUnion('kind', [PersonFrontMatterSchema, MatterFrontMatterSchema]);
export type PageFrontMatter = z.infer<typeof PageFrontMatterSchema>;

/** Characters that would end a line in a viewer, so fact text may not hold them. */
const LINE_BREAK_PATTERN = /[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * The text of one fact: a single trimmed line that holds no hidden comment, so it renders as exactly
 * one bullet and its marker always lands on that same line.
 */
export const PageFactTextSchema = z
  .string()
  .trim()
  .min(1, 'A fact cannot be empty. Write a few words and try again.')
  .refine(text => !LINE_BREAK_PATTERN.test(text), 'A fact must be one line. Remove the line breaks and try again.')
  .refine(text => !text.includes('<!--'), 'A fact cannot contain "<!--". Remove it and try again.');

/** One fact bullet: its text without the leading `- ` and without the marker, plus the marker. */
export const PageFactSchema = z.object({ text: PageFactTextSchema, marker: FactMarkerSchema });
export type PageFact = z.infer<typeof PageFactSchema>;

/** Thrown when fact text could not stand as one bullet. The message says what to change. */
export class PageFactTextError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'PageFactTextError';
  }
}

/** The fact with its text checked and trimmed, or a `PageFactTextError`. Every writer builds facts through this. */
export function parsePageFact(fact: PageFact): PageFact {
  const parsed = PageFactSchema.safeParse(fact);
  if (!parsed.success) {
    throw new PageFactTextError(parsed.error.issues[0]?.message ?? 'A fact must be one line of plain text.', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * One line of a page body. A `fact` line is a bullet that ends with a readable fact marker. An
 * `unreadable` line is a bullet that carries a hidden comment (or text that cannot stand as a
 * fact) but no readable marker: it fails closed as unconfirmed, never as the person's own words.
 * Everything else (blank lines, prose, a bullet with no comment, an indented note) is `other`.
 * `raw` is the line as read; a line a change produced has none.
 */
export type PageLine =
  | { kind: 'fact'; fact: PageFact; raw: string | undefined }
  | { kind: 'other'; raw: string }
  | { kind: 'unreadable'; raw: string };

/**
 * A `## ` heading and the lines under it. `name` is set when the heading is one of
 * `PAGE_SECTIONS` (matched after trimming, case-sensitive); any other heading is kept as is.
 */
export interface PageSectionBlock {
  name: PageSection | undefined;
  /** The heading line as read, or undefined when a change made the section. */
  rawHeading: string | undefined;
  /** The heading text without `## `; equals `name` for a known section. */
  heading: string;
  lines: PageLine[];
}

/**
 * How the YAML block renders: `none` for a page that never had one, `raw` for the lines as
 * read (fence lines included, so a `\r` on a fence survives), `canonical` for a fresh page or
 * one whose front matter a change touched.
 */
export type PageFrontMatterBlock = { kind: 'none' } | { kind: 'raw'; lines: string[] } | { kind: 'canonical' };

export interface MemoryPage {
  frontMatter: PageFrontMatter;
  /** YAML keys the format does not know. They are written back after the known keys, never dropped. */
  extraFrontMatter: Record<string, unknown>;
  frontMatterBlock: PageFrontMatterBlock;
  /** Every line between the front matter and the first `## ` heading: the `# ` title line, the summary, blanks. */
  preamble: string[];
  sections: PageSectionBlock[];
  /** Whether the file ended with a newline; a fresh page does. */
  endsWithNewline: boolean;
  /** Whether the file began with a UTF-8 byte order mark, kept so the bytes come back exactly. */
  hasBom: boolean;
}

/** What a parser needs when the page carries no usable front matter: where it was found and what to call it. */
export interface PageParseFallback {
  kind: PageKind;
  title: string;
}

/**
 * Reads a page from its text. Never throws: a page with no front matter, a broken YAML block,
 * no headings, or bullets with no marker is still a page. The front matter is the lines
 * between a first line `---` and the next line `---` (both exact, after dropping a trailing
 * `\r`); with no closing fence there is no front matter and every line is body. A block that
 * does not parse, or parses to something other than a map, is kept raw and treated as
 * missing. A known key whose value does not fit the schema takes its fallback (`kind` and
 * `title` from `fallback`, the rest their defaults) and is not an extra key. The `# ` heading
 * line is never consulted for the title, so a hand-edited heading does not rename the page.
 */
export function parseMemoryPage({ content, fallback }: { content: string; fallback: PageParseFallback }): MemoryPage {
  const hasBom = content.startsWith(BOM);
  const text = hasBom ? content.slice(BOM.length) : content;
  const split = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const lines = endsWithNewline ? split.slice(0, -1) : split;

  let frontMatterBlock: PageFrontMatterBlock = { kind: 'none' };
  let values: Record<string, unknown> = {};
  let body = lines;
  const [first] = lines;
  if (first !== undefined && isFenceLine(first)) {
    const close = lines.findIndex((line, index) => index > 0 && isFenceLine(line));
    if (close !== -1) {
      const inner = lines.slice(1, close);
      frontMatterBlock = { kind: 'raw', lines: lines.slice(0, close + 1) };
      values = readFrontMatterMap(inner);
      body = lines.slice(close + 1);
    }
  }

  const { frontMatter, extraFrontMatter } = frontMatterFrom({ values, fallback });
  const { preamble, sections } = parseBody(body);
  return { frontMatter, extraFrontMatter, frontMatterBlock, preamble, sections, endsWithNewline, hasBom };
}

/**
 * The page as bytes. Each line renders from its raw text when it has one, else canonically:
 * a fact line is `- <text> <marker>`, a known section heading is `## <name>`. The front
 * matter renders from a `raw` block's lines as they are, from a `canonical` block as `kind`, `title`, `aliases`
 * (flow style: `[a, b]`), then `household` or `status`, then every extra key in insertion
 * order, each on one line (no folding), between `---` fences; a `none` block renders nothing. Output is the front matter lines, the preamble, then
 * each section's heading and lines; one blank line is inserted before a section heading when
 * the lines before it do not already end with a blank line. Lines join with `\n`, plus a
 * final `\n` when `endsWithNewline`. A parsed page carries its own blanks as raw lines, so
 * nothing is inserted and the bytes come back exactly. A page that began with a byte order mark gets it back.
 */
export function renderMemoryPage(page: MemoryPage): string {
  const lines = renderLines(page);
  return `${page.hasBom ? BOM : ''}${endsWithNewlineSuffix(lines, page.endsWithNewline)}`;
}

/** A fresh page with its kind's standard sections, a `# <title>` line, and an empty summary line. */
export function newMemoryPage(frontMatter: PageFrontMatter): MemoryPage {
  return {
    frontMatter,
    extraFrontMatter: {},
    frontMatterBlock: { kind: 'canonical' },
    preamble: [`# ${frontMatter.title}`, '', ''],
    sections: PAGE_SECTIONS_BY_KIND[frontMatter.kind].map((name): PageSectionBlock => ({
      name,
      rawHeading: undefined,
      heading: name,
      lines: [],
    })),
    endsWithNewline: true,
    hasBom: false,
  };
}

/** Every fact on the page with the section it sits in, in page order. */
export function pageFacts(page: MemoryPage): { section: PageSectionBlock; fact: PageFact }[] {
  const entries: { section: PageSectionBlock; fact: PageFact }[] = [];
  for (const section of page.sections) {
    for (const line of section.lines) {
      if (line.kind === 'fact') {
        entries.push({ section, fact: line.fact });
      }
    }
  }
  return entries;
}

/** The fact with this id, wherever it sits, or undefined. */
export function findFact(page: MemoryPage, id: FactId): { section: PageSectionBlock; fact: PageFact } | undefined {
  return pageFacts(page).find(entry => entry.fact.marker.id === id);
}

/**
 * The page with a fact appended to a section: the new line goes after the section's last
 * non-blank line, so a parsed section keeps its closing blank line last. A section the page
 * lacks is added after the last section that precedes it in `PAGE_SECTIONS` order (or at the
 * end). The new line is canonical. Throws `PageFactTextError` when the text cannot stand as one
 * line. Returns a new page; the input is not changed.
 */
export function addFact(page: MemoryPage, input: { section: PageSection; fact: PageFact }): MemoryPage {
  const line: PageLine = { kind: 'fact', fact: parsePageFact(input.fact), raw: undefined };
  if (!page.sections.some(section => section.name === input.section)) {
    const created: PageSectionBlock = {
      name: input.section,
      rawHeading: undefined,
      heading: input.section,
      lines: [line],
    };
    return { ...page, sections: insertSection({ sections: page.sections, section: created, name: input.section }) };
  }
  return {
    ...page,
    sections: page.sections.map(section =>
      section.name === input.section
        ? { ...section, lines: insertAfterLastContent({ lines: section.lines, line }) }
        : section,
    ),
  };
}

/**
 * The page with one fact moved to the end of Earlier, its marker gaining `until` (and losing
 * `seen`). The id and text are kept. A fact already in Earlier only gets its `until` updated
 * in place. Unknown id: the page is returned unchanged.
 */
export function moveFactToEarlier(page: MemoryPage, input: { id: FactId; until: FactDate }): MemoryPage {
  const found = findFact(page, input.id);
  if (found === undefined) {
    return page;
  }
  const marker = markerWithUntil({ marker: found.fact.marker, until: input.until });
  if (found.section.name === 'Earlier') {
    return rewriteFact({ page, id: input.id, marker });
  }
  return addFact(removeFact({ page, id: input.id }), {
    section: 'Earlier',
    fact: { text: found.fact.text, marker },
  });
}

/**
 * The page with one fact's marker rewritten (`src`, dates); its text and position are kept.
 * Unknown id: unchanged.
 */
export function updateFactMarker(page: MemoryPage, input: { id: FactId; marker: FactMarker }): MemoryPage {
  if (findFact(page, input.id) === undefined) {
    return page;
  }
  return rewriteFact({ page, id: input.id, marker: input.marker });
}

/**
 * The page with every hand-written bullet (`- ` or `* `, any indent, no hidden comment) inside a
 * known section turned into a fact with a fresh id, the given source and `since`. Bullets outside
 * known sections, bullets with a broken marker, and every other line stay as they are. This is how a hand-written line becomes
 * the person's own fact at the next write.
 */
export function stampUnmarkedBullets(
  page: MemoryPage,
  input: { src: FactSource; since: FactDate; newId: () => FactId },
): MemoryPage {
  return {
    ...page,
    sections: page.sections.map(section => {
      if (section.name === undefined) {
        return section;
      }
      return {
        ...section,
        lines: section.lines.map((line): PageLine => {
          if (line.kind !== 'other' || !UNMARKED_BULLET_PATTERN.test(line.raw)) {
            return line;
          }
          return {
            kind: 'fact',
            fact: parsePageFact({
              text: line.raw.replace(BULLET_PREFIX_PATTERN, ''),
              marker: { kind: 'fact', id: input.newId(), src: input.src, since: input.since },
            }),
            raw: undefined,
          };
        }),
      };
    }),
  };
}

/**
 * The page with its summary set. The summary is the third preamble line when the preamble
 * starts with a `# ` line, a blank line, and any third line (blank or not): that line is
 * replaced. Otherwise a blank line, the summary and a blank line are inserted right after
 * the `# ` line, and a preamble with no `# ` line first gets `# <title>`.
 */
export function setSummary(page: MemoryPage, summary: string): MemoryPage {
  const { preamble } = page;
  const [first, second, third] = preamble;
  if (first?.startsWith('# ')) {
    if (second !== undefined && isBlankText(second) && third !== undefined) {
      return { ...page, preamble: [first, second, summary, ...preamble.slice(3)] };
    }
    return { ...page, preamble: [first, '', summary, '', ...preamble.slice(1)] };
  }
  return { ...page, preamble: [`# ${page.frontMatter.title}`, '', summary, '', ...preamble] };
}

/** Where a page lives: `<vaultDir>/<folder>/<slug>.md`. */
export function pagePath({ vaultDir, kind, slug }: { vaultDir: string; kind: PageKind; slug: string }): string {
  if (!isPageSlug(slug)) {
    throw new Error(`Not a page name: ${slug}`);
  }
  return path.join(vaultDir, PAGE_FOLDERS[kind], `${slug}.md`);
}

/** One page's place in a vault listing. */
export interface PageListing {
  kind: PageKind;
  slug: string;
}

/** Every page in a vault, people first then matters, each folder sorted by slug. A file whose name is not a page slug is not a page. */
export async function listMemoryPages(vaultDir: string): Promise<PageListing[]> {
  const listings: PageListing[] = [];
  for (const kind of PAGE_KINDS) {
    const slugs = await listFolderSlugs(path.join(vaultDir, PAGE_FOLDERS[kind]));
    for (const slug of slugs) {
      listings.push({ kind, slug });
    }
  }
  return listings;
}

/** The page at this path, or undefined when the file does not exist. Read errors other than ENOENT throw. */
export async function readMemoryPage(input: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  /** Used as the fallback title when the page's own front matter has none. */
  title?: string | undefined;
}): Promise<MemoryPage | undefined> {
  let content: string;
  try {
    content = await readFile(pagePath(input), 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  return parseMemoryPage({ content, fallback: { kind: input.kind, title: input.title ?? input.slug } });
}

/**
 * Writes a page by temp file plus rename in the page's own folder, so a crash never leaves a
 * half-written page and the old file stays until the new one is complete. Creates the folder.
 * Callers hold the vault lock.
 */
export async function writeMemoryPage(input: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  page: MemoryPage;
}): Promise<void> {
  const target = pagePath(input);
  const folder = path.dirname(target);
  await mkdir(folder, { recursive: true });
  const temp = path.join(folder, `.${input.slug}.md.tmp-${randomUUID()}`);
  try {
    await writeFile(temp, renderMemoryPage(input.page), 'utf8');
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * A slug for a new page that no existing page in the folder uses: `pageSlug(title)`, then
 * `-2`, `-3`, … on a clash with a page whose title differs. A page with the same title
 * keeps its slug (the caller then has an existing page, not a new one).
 */
export async function freePageSlug(input: { vaultDir: string; kind: PageKind; title: string }): Promise<string> {
  const base = pageSlug(input.title);
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${String(suffix)}`;
    const existing = await readMemoryPage({ vaultDir: input.vaultDir, kind: input.kind, slug: candidate });
    if (existing === undefined || existing.frontMatter.title === input.title) {
      return candidate;
    }
  }
}

const FENCE = '---';
const BOM = '\uFEFF';
const BULLET_PREFIX_PATTERN = /^\s*[-*]\s+/;
const UNMARKED_BULLET_PATTERN = /^\s*[-*]\s+\S/;

/** The text of a bullet the person typed by hand, or undefined for any other line. */
export function unmarkedBulletText(raw: string): string | undefined {
  return UNMARKED_BULLET_PATTERN.test(raw) ? raw.replace(BULLET_PREFIX_PATTERN, '').trimEnd() : undefined;
}
const YAML_LINE: ToStringOptions = { lineWidth: 0 };
const YAML_FLOW: ToStringOptions = { lineWidth: 0, collectionStyle: 'flow', flowCollectionPadding: false };

function isFenceLine(line: string): boolean {
  return line.replace(/\r$/, '') === FENCE;
}

function isBlankText(text: string): boolean {
  return text.trim() === '';
}

function isBlankLine(line: PageLine): boolean {
  return line.kind === 'other' && isBlankText(line.raw);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function listFolderSlugs(folder: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name.slice(0, -'.md'.length))
    .filter(isPageSlug)
    .sort((a, b) => (a < b ? -1 : 1));
}

function readFrontMatterMap(block: string[]): Record<string, unknown> {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(parse(block.join('\n')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function extraFrontMatterOf({
  values,
  known,
}: {
  values: Record<string, unknown>;
  known: readonly string[];
}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !known.includes(key)));
}

function frontMatterFrom({ values, fallback }: { values: Record<string, unknown>; fallback: PageParseFallback }): {
  frontMatter: PageFrontMatter;
  extraFrontMatter: Record<string, unknown>;
} {
  const parsedKind = PageKindSchema.safeParse(values['kind']);
  const kind = parsedKind.success ? parsedKind.data : fallback.kind;
  const parsedTitle = PersonFrontMatterSchema.shape.title.safeParse(values['title']);
  const title = parsedTitle.success ? parsedTitle.data : fallback.title;
  const parsedAliases = PersonFrontMatterSchema.shape.aliases.safeParse(values['aliases']);
  const aliases = parsedAliases.success ? parsedAliases.data : [];

  if (kind === 'person') {
    const parsedHousehold = PersonFrontMatterSchema.shape.household.safeParse(values['household']);
    const known = ['kind', 'title', 'aliases', 'household'];
    return {
      frontMatter: { kind, title, aliases, household: parsedHousehold.success ? parsedHousehold.data : false },
      extraFrontMatter: extraFrontMatterOf({ values, known }),
    };
  }
  const parsedStatus = MatterFrontMatterSchema.shape.status.safeParse(values['status']);
  const known = ['kind', 'title', 'aliases', 'status'];
  return {
    frontMatter: { kind, title, aliases, status: parsedStatus.success ? parsedStatus.data : 'active' },
    extraFrontMatter: extraFrontMatterOf({ values, known }),
  };
}

function parseBody(lines: string[]): { preamble: string[]; sections: PageSectionBlock[] } {
  const preamble: string[] = [];
  const sections: PageSectionBlock[] = [];
  let current: PageSectionBlock | undefined;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.slice('## '.length).trim();
      const parsedName = PageSectionSchema.safeParse(heading);
      current = { name: parsedName.success ? parsedName.data : undefined, rawHeading: line, heading, lines: [] };
      sections.push(current);
    } else if (current === undefined) {
      preamble.push(line);
    } else {
      current.lines.push(parseSectionLine(line));
    }
  }
  return { preamble, sections };
}

// A bullet with a hidden comment is the person's own hand edit only when it has none: a comment that
// fails to read as a fact marker (typo, unknown key, bad date) must never pass as their words.
function parseSectionLine(raw: string): PageLine {
  if (!BULLET_PREFIX_PATTERN.test(raw)) {
    return { kind: 'other', raw };
  }
  const { text, marker } = splitFactMarker(raw);
  // The space lets a bullet with nothing after the dash lose its prefix too.
  const body = `${text} `.replace(BULLET_PREFIX_PATTERN, '').trim();
  const fact = marker === undefined ? undefined : PageFactSchema.safeParse({ text: body, marker });
  if (fact?.success) {
    return { kind: 'fact', fact: fact.data, raw };
  }
  const handWritten = !raw.includes('<!--') && (body === '' || PageFactTextSchema.safeParse(body).success);
  return handWritten ? { kind: 'other', raw } : { kind: 'unreadable', raw };
}

function renderLine(line: PageLine): string {
  if (line.kind !== 'fact') {
    return line.raw;
  }
  return line.raw ?? `- ${line.fact.text} ${formatMarker(line.fact.marker)}`;
}

function renderFrontMatterLines(page: MemoryPage): string[] {
  const block = page.frontMatterBlock;
  if (block.kind === 'none') {
    return [];
  }
  if (block.kind === 'raw') {
    return [...block.lines];
  }
  const { frontMatter, extraFrontMatter } = page;
  const kindLines =
    frontMatter.kind === 'person' ? [`household: ${String(frontMatter.household)}`] : [`status: ${frontMatter.status}`];
  const extraLines = Object.entries(extraFrontMatter).map(
    ([key, value]) => `${stringify(key, YAML_LINE).trimEnd()}: ${stringify(value, YAML_FLOW).trimEnd()}`,
  );
  return [
    FENCE,
    `kind: ${frontMatter.kind}`,
    `title: ${stringify(frontMatter.title, YAML_LINE).trimEnd()}`,
    `aliases: ${stringify(frontMatter.aliases, YAML_FLOW).trimEnd()}`,
    ...kindLines,
    ...extraLines,
    FENCE,
  ];
}

function renderLines(page: MemoryPage): string[] {
  const lines = renderFrontMatterLines(page);
  lines.push(...page.preamble);
  for (const section of page.sections) {
    if (section.rawHeading !== undefined) {
      lines.push(section.rawHeading);
    } else {
      const last = lines.at(-1);
      if (lines.length > 0 && !(last !== undefined && isBlankText(last))) {
        lines.push('');
      }
      lines.push(`## ${section.heading}`);
    }
    for (const line of section.lines) {
      lines.push(renderLine(line));
    }
  }
  return lines;
}

function endsWithNewlineSuffix(lines: string[], endsWithNewline: boolean): string {
  return endsWithNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}

function markerWithUntil({ marker, until }: { marker: FactMarker; until: FactDate }): FactMarker {
  const kept: FactMarker = { ...marker, until };
  delete kept.seen;
  return kept;
}

function mapLines({ page, change }: { page: MemoryPage; change: (lines: PageLine[]) => PageLine[] }): MemoryPage {
  return {
    ...page,
    sections: page.sections.map(section => ({ ...section, lines: change(section.lines) })),
  };
}

// Only the first line with the id is touched: a pasted duplicate is the person's to sort out.
function rewriteFact({ page, id, marker }: { page: MemoryPage; id: FactId; marker: FactMarker }): MemoryPage {
  let done = false;
  return mapLines({
    page,
    change: lines =>
      lines.map((line): PageLine => {
        if (!done && line.kind === 'fact' && line.fact.marker.id === id) {
          done = true;
          return { kind: 'fact', fact: { text: line.fact.text, marker }, raw: undefined };
        }
        return line;
      }),
  });
}

function removeFact({ page, id }: { page: MemoryPage; id: FactId }): MemoryPage {
  let done = false;
  return mapLines({
    page,
    change: lines =>
      lines.filter(line => {
        if (!done && line.kind === 'fact' && line.fact.marker.id === id) {
          done = true;
          return false;
        }
        return true;
      }),
  });
}

function insertAfterLastContent({ lines, line }: { lines: PageLine[]; line: PageLine }): PageLine[] {
  let at = 0;
  for (const [index, existing] of lines.entries()) {
    if (!isBlankLine(existing)) {
      at = index + 1;
    }
  }
  return [...lines.slice(0, at), line, ...lines.slice(at)];
}

function insertSection({
  sections,
  section,
  name,
}: {
  sections: PageSectionBlock[];
  section: PageSectionBlock;
  name: PageSection;
}): PageSectionBlock[] {
  const position = PAGE_SECTIONS.indexOf(name);
  let at = 0;
  for (const [index, existing] of sections.entries()) {
    if (existing.name !== undefined && PAGE_SECTIONS.indexOf(existing.name) < position) {
      at = index + 1;
    }
  }
  return [...sections.slice(0, at), section, ...sections.slice(at)];
}
