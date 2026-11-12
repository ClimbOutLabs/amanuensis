/**
 * Pages: one Markdown file per person (`people/<slug>.md`) or matter (`matters/<slug>.md`)
 * inside a vault.
 *
 * Canonical owner of the page format. Reading never fails: any text is a page, however oddly shaped,
 * and a page that is read and rendered again comes back byte for byte. Only a line a change touched
 * is written differently.
 */
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify, type ToStringOptions } from 'yaml';
import { z } from 'zod';

import { FactMarkerSchema, formatMarker, splitFactMarker, type FactMarker, type FactSource } from './memoryNotes';
import { isPageSlug, pageSlug, UNTITLED_PAGE_SLUG } from './pageSlug';

const PAGE_KINDS = ['person', 'matter'] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKindSchema>;

/** The vault folder each kind of page lives in. */
const PAGE_FOLDERS: Readonly<Record<PageKind, string>> = { person: 'people', matter: 'matters' };

/** The sections a page may have. */
export const PAGE_SECTIONS = ['How you write to them', 'Now', 'Decided', 'Open', 'Unconfirmed', 'Earlier'] as const;
export const PageSectionSchema = z.enum(PAGE_SECTIONS);
export type PageSection = z.infer<typeof PageSectionSchema>;

const MatterStatusSchema = z.enum(['active', 'done']);

const pageFrontMatterBase = {
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** One short line Aman wrote on what the page covers. Shown to the person only; never the person's words. */
  about: z.string().optional(),
};

const PersonFrontMatterSchema = z.object({
  kind: z.literal('person'),
  ...pageFrontMatterBase,
  household: z.boolean().default(false),
});

const MatterFrontMatterSchema = z.object({
  kind: z.literal('matter'),
  ...pageFrontMatterBase,
  status: MatterStatusSchema.default('active'),
});

/** The YAML block at the top of a page. Keys outside this schema are ignored. */
const PageFrontMatterSchema = z.discriminatedUnion('kind', [PersonFrontMatterSchema, MatterFrontMatterSchema]);
export type PageFrontMatter = z.infer<typeof PageFrontMatterSchema>;

/** Characters that would end a line in a viewer, so fact text may not hold them. */
const LINE_BREAK_PATTERN = /[\n\r\v\f\u0085\u2028\u2029]/;

/** Whether text holds a character that ends a line in a viewer. */
export function hasLineBreak(text: string): boolean {
  return LINE_BREAK_PATTERN.test(text);
}

/**
 * The text of one fact: a single trimmed line that holds no hidden comment, so it renders as exactly
 * one bullet and its marker always lands on that same line.
 */
const PageFactTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine(text => !hasLineBreak(text))
  .refine(text => !text.includes('<!--'));

/** One fact bullet: its text without the leading `- ` and without the marker, plus the marker. */
const PageFactSchema = z.object({ text: PageFactTextSchema, marker: FactMarkerSchema });
type PageFact = z.infer<typeof PageFactSchema>;

/**
 * One line of a page body. A `fact` line is a bullet that ends with a readable fact marker. An
 * `unreadable` line is a bullet that carries a hidden comment (or text that cannot stand as a
 * fact) but no readable marker: it fails closed as unconfirmed, never as the person's own words.
 * A non-bullet line that carries a hidden comment is `unreadable` too. Everything else (blank lines,
 * prose, a bullet with no comment, an indented note) is `other`.
 * `raw` is the whole line without its line ending and is what gets written back; `crlf` says the
 * line ended in `\r\n`.
 */
export type PageLine =
  | { kind: 'fact'; fact: PageFact; raw: string; crlf: boolean }
  | { kind: 'other'; raw: string; crlf: boolean }
  | { kind: 'unreadable'; raw: string; crlf: boolean };

/**
 * A `## ` heading and the lines under it. `name` is set when the heading is one of
 * `PAGE_SECTIONS` (matched after trimming, case-sensitive); any other heading is kept as is.
 */
export interface PageSectionBlock {
  name: PageSection | undefined;
  /** The heading text without `## `; equals `name` for a known section. */
  heading: string;
  /** The heading line as written, without its line ending. */
  rawHeading: string;
  crlf: boolean;
  lines: PageLine[];
}

export interface MemoryPage {
  frontMatter: PageFrontMatter;
  /** The settings block as read, fences included and line endings kept; empty when the page has none. Never edited. */
  frontMatterLines: string[];
  /** Every line between the front matter and the first `## ` heading: the `# ` title line, the summary, blanks. Line endings are kept. */
  preamble: string[];
  sections: PageSectionBlock[];
  /** Whether the text ended with a line break. */
  endsWithNewline: boolean;
  /** Whether the text began with a byte order mark. */
  hasBom: boolean;
}

/** Where a page was found, which fixes its kind, and what to call it when the front matter has no usable title. */
interface PageParseFallback {
  kind: PageKind;
  title: string;
}

/**
 * Reads a page from its text. Never throws: a page with no front matter, a broken YAML block,
 * no headings, or bullets with no marker is still a page. The front matter is the lines
 * between a first line `---` and the next line `---` (both exact); with no closing fence there is no front matter and every line is body. A block that
 * does not parse, or parses to something other than a map, is treated as
 * missing. A known key whose value does not fit the schema takes its fallback (`title` from
 * `fallback`, the rest their defaults); unknown keys are ignored. The `# ` heading
 * line is never consulted for the title, so a hand-edited heading does not rename the page. The kind
 * is `fallback.kind`, the folder the file was found in; a `kind` key that disagrees is ignored.
 */
export function parseMemoryPage({ content, fallback }: { content: string; fallback: PageParseFallback }): MemoryPage {
  const hasBom = content.startsWith(BOM);
  const text = hasBom ? content.slice(BOM.length) : content;
  const endsWithNewline = text.endsWith('\n');
  const split = text.split('\n');
  // Each line keeps a trailing `\r` for now so it can be written back as it was.
  const lines = endsWithNewline ? split.slice(0, -1) : split;

  let values: Record<string, unknown> = {};
  let frontMatterLines: string[] = [];
  let body = lines;
  const [first] = lines;
  if (first !== undefined && isFenceLine(first)) {
    const close = lines.findIndex((line, index) => index > 0 && isFenceLine(line));
    if (close !== -1) {
      values = readFrontMatterMap(lines.slice(1, close).map(withoutCarriageReturn));
      frontMatterLines = lines.slice(0, close + 1);
      body = lines.slice(close + 1);
    }
  }

  const { preamble, sections } = parseBody(body);
  return {
    frontMatter: frontMatterFrom({ values, fallback }),
    frontMatterLines,
    preamble,
    sections,
    endsWithNewline,
    hasBom,
  };
}

/**
 * The page as text. The front matter and the preamble come back as they were read; each section is its heading
 * line then its lines, each with the line ending it had. Reading a page and rendering it returns the same bytes.
 */
export function renderMemoryPage(page: MemoryPage): string {
  const lines = [...page.frontMatterLines, ...page.preamble];
  for (const section of page.sections) {
    lines.push(`${section.rawHeading}${section.crlf ? '\r' : ''}`);
    for (const line of section.lines) {
      lines.push(`${line.raw}${line.crlf ? '\r' : ''}`);
    }
  }
  return `${page.hasBom ? BOM : ''}${lines.join('\n')}${page.endsWithNewline ? '\n' : ''}`;
}

/** A fact's day (`2026`, `2026-03` or `2026-03-14`). */
type FactDate = NonNullable<FactMarker['since']>;

/** A readable fact on a page and where it sits, so a change can address that exact line even when ids repeat. */
export interface FactLocation {
  section: PageSectionBlock;
  sectionIndex: number;
  lineIndex: number;
  fact: PageFact;
}

/** Every fact with a readable marker, in page order. Lines with an unreadable marker are not facts. */
export function pageFacts(page: MemoryPage): FactLocation[] {
  const found: FactLocation[] = [];
  for (const [sectionIndex, section] of page.sections.entries()) {
    for (const [lineIndex, line] of section.lines.entries()) {
      if (line.kind === 'fact') {
        found.push({ section, sectionIndex, lineIndex, fact: line.fact });
      }
    }
  }
  return found;
}

/** The sources that are the person's own words typed or written by them; `sent_mail` is a message they sent, which may echo mail. */
export const OWN_WORDS_SOURCES: ReadonlySet<FactSource> = new Set<FactSource>(['you_said', 'you_edited']);

/**
 * What the page is about, in a few words: the line under the title when the person wrote one, otherwise the
 * first statement under Now that is the person's own (confirmed from their words or typed by hand). A statement
 * from mail, the calendar or anything read is never the summary. Undefined when the page has neither.
 */
export function pageSummary(page: MemoryPage): string | undefined {
  const written = page.preamble.map(line => line.trim()).find(line => line !== '' && !line.startsWith('# '));
  if (written !== undefined) {
    return written;
  }
  for (const line of page.sections.find(section => section.name === 'Now')?.lines ?? []) {
    if (line.kind === 'fact' && OWN_WORDS_SOURCES.has(line.fact.marker.src)) {
      return line.fact.text;
    }
    const typed = line.kind === 'other' ? unmarkedBulletText(line.raw) : undefined;
    if (typed !== undefined && typed !== '') {
      return typed;
    }
  }
  return undefined;
}

/**
 * The one line the screen shows for a page: the line the person wrote under the title, else the line Aman
 * wrote on what the page covers, else the person's first own statement. The model is never shown this line.
 */
export function pageDescription(page: MemoryPage): string | undefined {
  const written = page.preamble.map(line => line.trim()).find(line => line !== '' && !line.startsWith('# '));
  return written ?? page.frontMatter.about ?? pageSummary(page);
}

/**
 * The page with Aman's line on what it covers set in its settings block. The block's other lines stay as read.
 * A page with no settings block, or one whose line was spread over several lines by hand, is returned unchanged.
 */
export function withPageAbout(page: MemoryPage, about: string): MemoryPage {
  const close = page.frontMatterLines.length - 1;
  if (close < 1) {
    return page;
  }
  const keyLines = page.frontMatterLines.flatMap((line, index) => (line.startsWith(ABOUT_PREFIX) ? [index] : []));
  const [at] = keyLines;
  const next = at === undefined ? undefined : page.frontMatterLines[at + 1];
  if (keyLines.length > 1 || (next !== undefined && /^\s/.test(next))) {
    return page;
  }
  const closing = page.frontMatterLines[close] ?? FENCE;
  const line = `${ABOUT_KEY}: ${stringify(about, YAML_LINE).trimEnd()}${closing.endsWith('\r') ? '\r' : ''}`;
  const frontMatterLines =
    at === undefined
      ? [...page.frontMatterLines.slice(0, close), line, closing]
      : page.frontMatterLines.map((existing, index) => (index === at ? line : existing));
  return { ...page, frontMatter: { ...page.frontMatter, about }, frontMatterLines };
}

/** The sections a fresh page of each kind may list, in page order. "How you write to them" is for people only. */
const SECTIONS_OF_KIND: Readonly<Record<PageKind, readonly PageSection[]>> = {
  person: PAGE_SECTIONS.filter(name => name !== 'Decided' && name !== 'Open'),
  matter: PAGE_SECTIONS.filter(name => name !== 'How you write to them'),
};

/** Whether a page of this kind has a place for facts in this section. */
export function kindHasSection({ kind, section }: { kind: PageKind; section: PageSection }): boolean {
  return SECTIONS_OF_KIND[kind].includes(section);
}

/** A page with no facts yet: settings, a `# ` title line and a blank line. Sections appear when a fact needs one. */
export function newMemoryPage({ kind, title }: { kind: PageKind; title: string }): MemoryPage {
  const kindLine = kind === 'person' ? 'household: false' : 'status: active';
  return {
    frontMatter:
      kind === 'person'
        ? { kind, title, aliases: [], household: false }
        : { kind, title, aliases: [], status: 'active' },
    frontMatterLines: [
      FENCE,
      `kind: ${kind}`,
      `title: ${stringify(title, YAML_LINE).trimEnd()}`,
      'aliases: []',
      kindLine,
      FENCE,
    ],
    preamble: [`# ${title}`, ''],
    sections: [],
    endsWithNewline: true,
    hasBom: false,
  };
}

/** A fact as its bullet line: `- <text> <marker>`. */
function factLineText(fact: PageFact): string {
  return `- ${fact.text} ${formatMarker(fact.marker)}`;
}

/**
 * The page with a fact added at the end of a section, after the section's last line that is not blank. A section
 * the page lacks is created in its usual place, with a blank line kept between sections.
 */
export function addFact(page: MemoryPage, input: { section: PageSection; fact: PageFact }): MemoryPage {
  const fact = PageFactSchema.parse(input.fact);
  const index = page.sections.findIndex(section => section.name === input.section);
  const existing = page.sections[index];
  if (existing === undefined) {
    return insertSection({ page, name: input.section, fact });
  }
  const line: PageLine = { kind: 'fact', fact, raw: factLineText(fact), crlf: lineEndingOf(existing) };
  const at = existing.lines.findLastIndex(candidate => !isBlankLine(candidate)) + 1;
  const lines = [...existing.lines.slice(0, at), line, ...existing.lines.slice(at)];
  return { ...page, sections: page.sections.map((section, i) => (i === index ? { ...section, lines } : section)) };
}

/** The page with this fact's marker rewritten and nothing else on its line touched. */
export function withFactMarker(page: MemoryPage, input: { at: FactLocation; marker: FactMarker }): MemoryPage {
  const line = page.sections[input.at.sectionIndex]?.lines[input.at.lineIndex];
  if (line?.kind !== 'fact') {
    return page;
  }
  const markerStart = line.raw.lastIndexOf('<!--');
  const replaced: PageLine = {
    kind: 'fact',
    fact: { text: line.fact.text, marker: input.marker },
    raw: `${line.raw.slice(0, markerStart)}${formatMarker(input.marker)}`,
    crlf: line.crlf,
  };
  return replaceLine({ page, at: input.at, lines: [replaced] });
}

/** The page without this fact's line. */
export function removeFact(page: MemoryPage, input: { at: FactLocation }): MemoryPage {
  return replaceLine({ page, at: input.at, lines: [] });
}

/**
 * The page with a fact moved to the end of Earlier. Its marker gains `until` and loses `seen`; its text, id and
 * source stay. A fact that is in Earlier already is left where it is.
 */
export function moveFactToEarlier(page: MemoryPage, input: { at: FactLocation; until: FactDate }): MemoryPage {
  if (input.at.section.name === 'Earlier') {
    return page;
  }
  const { id, src, since } = input.at.fact.marker;
  const marker = FactMarkerSchema.parse({ kind: 'fact', id, src, since, until: input.until });
  const removed = replaceLine({ page, at: input.at, lines: [] });
  return addFact(removed, { section: 'Earlier', fact: { text: input.at.fact.text, marker } });
}

/**
 * The page with every bullet the person typed by hand (no hidden comment) in a known section given a marker made by
 * `markerFor`. The text part of the line is not touched. Bullets elsewhere, bullets whose marker is broken and every
 * other line stay as they are.
 */
export function stampUnmarkedBullets(page: MemoryPage, markerFor: () => FactMarker): MemoryPage {
  return {
    ...page,
    sections: page.sections.map(section => {
      if (section.name === undefined) {
        return section;
      }
      return {
        ...section,
        lines: section.lines.map((line): PageLine => {
          const text = line.kind === 'other' ? unmarkedBulletText(line.raw) : undefined;
          const parsed = text === undefined ? undefined : PageFactTextSchema.safeParse(text);
          if (line.kind !== 'other' || parsed?.success !== true) {
            return line;
          }
          const marker = markerFor();
          return {
            kind: 'fact',
            fact: { text: parsed.data, marker },
            raw: `${line.raw.trimEnd()} ${formatMarker(marker)}`,
            crlf: line.crlf,
          };
        }),
      };
    }),
  };
}

/**
 * Writes a page by temp file and rename in its own folder, with the file flushed to disk first, so a crash leaves
 * the old page or the new one and never half of one. Creates the folder. Callers hold the vault lock.
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
  // A leading dot keeps a crashed write out of the page list; the history never stages it.
  const temp = path.join(folder, `.${input.slug}.md.tmp-${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(renderMemoryPage(input.page), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Removes a page file. Callers hold the vault lock; the history keeps the page, so a delete can be undone. */
export async function removeMemoryPage(input: { vaultDir: string; kind: PageKind; slug: string }): Promise<void> {
  await rm(pagePath(input), { force: true });
}

function lineEndingOf(section: PageSectionBlock): boolean {
  return section.lines.at(-1)?.crlf ?? section.crlf;
}

function isBlankLine(line: PageLine): boolean {
  return line.kind === 'other' && line.raw.trim() === '';
}

function replaceLine({ page, at, lines }: { page: MemoryPage; at: FactLocation; lines: PageLine[] }): MemoryPage {
  return {
    ...page,
    sections: page.sections.map((section, sectionIndex) =>
      sectionIndex === at.sectionIndex
        ? {
            ...section,
            lines: [...section.lines.slice(0, at.lineIndex), ...lines, ...section.lines.slice(at.lineIndex + 1)],
          }
        : section,
    ),
  };
}

function insertSection({ page, name, fact }: { page: MemoryPage; name: PageSection; fact: PageFact }): MemoryPage {
  const rank = PAGE_SECTIONS.indexOf(name);
  const before = page.sections.findLastIndex(
    section => section.name !== undefined && PAGE_SECTIONS.indexOf(section.name) < rank,
  );
  const at = before + 1;
  const crlf = page.sections.at(-1)?.crlf ?? page.preamble.at(-1)?.endsWith('\r') ?? false;
  const blank: PageLine = { kind: 'other', raw: '', crlf };
  const created: PageSectionBlock = {
    name,
    heading: name,
    rawHeading: `## ${name}`,
    crlf,
    lines: [{ kind: 'fact', fact, raw: factLineText(fact), crlf }, ...(at < page.sections.length ? [blank] : [])],
  };
  const sections = page.sections.map((section, index): PageSectionBlock => {
    // The section above the new one needs a blank line before the new heading.
    const last = section.lines.at(-1);
    return index === at - 1 && !(last !== undefined && isBlankLine(last))
      ? { ...section, lines: [...section.lines, blank] }
      : section;
  });
  const preamble =
    at === 0 && !isBlankText(page.preamble.at(-1) ?? '') ? [...page.preamble, crlf ? '\r' : ''] : page.preamble;
  return { ...page, preamble, sections: [...sections.slice(0, at), created, ...sections.slice(at)] };
}

function isBlankText(text: string): boolean {
  return text.trim() === '';
}

/** Where a page lives: `<vaultDir>/<folder>/<slug>.md`. */
export function pagePath({ vaultDir, kind, slug }: { vaultDir: string; kind: PageKind; slug: string }): string {
  if (!isPageSlug(slug)) {
    throw new Error(`Not a page name: ${slug}`);
  }
  return path.join(vaultDir, PAGE_FOLDERS[kind], `${slug}.md`);
}

/** The vault folder a kind of page lives in, such as `people`. */
export function pageFolder(kind: PageKind): string {
  return PAGE_FOLDERS[kind];
}

/** Whether a file name stem can travel in an export as it is: one plain name that cannot climb out of its folder. */
function isCarryableStem(stem: string): boolean {
  return (
    stem.length > 0 &&
    !stem.startsWith('.') &&
    !/[\p{Cc}/\\]/u.test(stem) &&
    Buffer.byteLength(`${stem}.md`, 'utf8') <= MAX_FILE_NAME_BYTES
  );
}

/**
 * The page file a vault-relative path such as `people/wendy.md` names: its folder and the file name
 * without `.md`. `isSlug` says whether the name is a lowercase slug, the only kind Aman reads; any other
 * plain name is still carried as it is, so a move loses nothing. A path with more folders, no `.md`, a
 * hidden name or control characters is not a page file. A slug typed in decomposed form (as some archive
 * tools write it) is read in its composed form, so it lands under the name the loader looks for.
 */
export function parsePageFilePath(relativePath: string): { kind: PageKind; stem: string; isSlug: boolean } | undefined {
  const [folder, file, ...rest] = relativePath.split('/');
  const kind = PAGE_KINDS.find(candidate => PAGE_FOLDERS[candidate] === folder);
  if (kind === undefined || file === undefined || rest.length > 0 || !file.endsWith('.md')) {
    return undefined;
  }
  const stem = file.slice(0, -'.md'.length);
  const composed = stem.normalize('NFC');
  if (isPageSlug(composed)) {
    return { kind, stem: composed, isSlug: true };
  }
  return isCarryableStem(stem) ? { kind, stem, isSlug: false } : undefined;
}

/** Whether a vault-relative path sits in one of the page folders, whether or not its name is a page name. */
export function isInPageFolder(relativePath: string): boolean {
  const [folder, ...rest] = relativePath.split('/');
  return rest.length > 0 && PAGE_KINDS.some(kind => PAGE_FOLDERS[kind] === folder);
}

/** One page's place in a vault listing. */
export interface PageListing {
  kind: PageKind;
  slug: string;
}

/** One `.md` file in a vault's page folder, by folder and file name without `.md`. */
interface PageFile {
  kind: PageKind;
  stem: string;
}

/** Every `.md` file directly in a vault's page folders, whatever its name: people first then matters, each folder sorted. */
export async function listPageFiles(vaultDir: string): Promise<PageFile[]> {
  const files: PageFile[] = [];
  for (const kind of PAGE_KINDS) {
    for (const stem of await listFolderMarkdownNames(path.join(vaultDir, PAGE_FOLDERS[kind]))) {
      files.push({ kind, stem });
    }
  }
  return files;
}

/** Every page in a vault, people first then matters, each folder sorted by slug. A file whose name is not a page slug is not a page. */
export async function listMemoryPages(vaultDir: string): Promise<PageListing[]> {
  return (await listPageFiles(vaultDir))
    .filter(file => isPageSlug(file.stem))
    .map(file => ({ kind: file.kind, slug: file.stem }));
}

/** The `.md` files in a vault's page folders that `listMemoryPages` skips because the name is not a page slug, as `folder/file.md`. */
export async function listSkippedPageFiles(vaultDir: string): Promise<string[]> {
  return (await listPageFiles(vaultDir))
    .filter(file => !isPageSlug(file.stem))
    .map(file => `${PAGE_FOLDERS[file.kind]}/${file.stem}.md`);
}

/**
 * A page name for a new page that no file in its folder uses: `pageSlug(title)`, then `-2`, `-3` and so on when
 * that name is taken by a page with another title.
 */
export async function freePageSlug({
  vaultDir,
  kind,
  title,
}: {
  vaultDir: string;
  kind: PageKind;
  title: string;
}): Promise<string> {
  const base = pageSlug(title);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${String(suffix)}`;
    if ((await readMemoryPage({ vaultDir, kind, slug: candidate })) === undefined) {
      return candidate;
    }
  }
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

/** Longest file name in bytes that common file systems accept. */
const MAX_FILE_NAME_BYTES = 255;

const FENCE = '---';
const ABOUT_KEY = 'about';
const ABOUT_PREFIX = `${ABOUT_KEY}:`;
const BOM = '\uFEFF';
const YAML_LINE: ToStringOptions = { lineWidth: 0 };
const BULLET_PREFIX_PATTERN = /^\s*[-*]\s+/;
const UNMARKED_BULLET_PATTERN = /^\s*[-*]\s+\S/;

/** The text of a bullet the person typed by hand, or undefined for any other line. */
export function unmarkedBulletText(raw: string): string | undefined {
  return UNMARKED_BULLET_PATTERN.test(raw) ? raw.replace(BULLET_PREFIX_PATTERN, '').trimEnd() : undefined;
}

function hasCommentMark(raw: string): boolean {
  return raw.includes('<!--') || raw.includes('-->');
}

function isFenceLine(line: string): boolean {
  return withoutCarriageReturn(line) === FENCE;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function listFolderMarkdownNames(folder: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    // A file where the folder should be holds no pages.
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name.slice(0, -'.md'.length))
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

function frontMatterFrom({
  values,
  fallback,
}: {
  values: Record<string, unknown>;
  fallback: PageParseFallback;
}): PageFrontMatter {
  // The folder decides the kind; a `kind` key that disagrees with it is ignored.
  const { kind } = fallback;
  const parsedTitle = PersonFrontMatterSchema.shape.title.safeParse(values['title']);
  const title = parsedTitle.success ? parsedTitle.data : fallback.title || UNTITLED_PAGE_SLUG;
  const parsedAliases = PersonFrontMatterSchema.shape.aliases.safeParse(values['aliases']);
  const aliases = parsedAliases.success ? parsedAliases.data : [];

  // Each kind-specific key that does not fit takes its default, so the schema always accepts the result.
  const parsedAbout = z.string().trim().min(1).safeParse(values[ABOUT_KEY]);
  const about = parsedAbout.success && !hasLineBreak(parsedAbout.data) ? { about: parsedAbout.data } : {};
  if (kind === 'person') {
    const household = PersonFrontMatterSchema.shape.household.catch(false).parse(values['household']);
    return PageFrontMatterSchema.parse({ kind, title, aliases, household, ...about });
  }
  const status = MatterFrontMatterSchema.shape.status.catch('active').parse(values['status']);
  return PageFrontMatterSchema.parse({ kind, title, aliases, status, ...about });
}

function parseBody(lines: string[]): { preamble: string[]; sections: PageSectionBlock[] } {
  const preamble: string[] = [];
  const sections: PageSectionBlock[] = [];
  let current: PageSectionBlock | undefined;
  // True while a hidden comment opened on an earlier line has not closed yet.
  let inComment = false;
  for (const withEnding of lines) {
    const line = withoutCarriageReturn(withEnding);
    const crlf = line !== withEnding;
    if (line.startsWith('## ')) {
      const heading = line.slice('## '.length).trim();
      const parsedName = PageSectionSchema.safeParse(heading);
      current = {
        name: parsedName.success ? parsedName.data : undefined,
        heading,
        rawHeading: line,
        crlf,
        lines: [],
      };
      sections.push(current);
      inComment = false;
    } else if (current === undefined) {
      preamble.push(withEnding);
    } else {
      // A marker wrapped onto the next line leaves the bullet above it looking unmarked, so that bullet is not trusted.
      const previous = current.lines.at(-1);
      if (
        !inComment &&
        line.trimStart().startsWith('<!--') &&
        previous?.kind === 'other' &&
        unmarkedBulletText(previous.raw) !== undefined
      ) {
        current.lines[current.lines.length - 1] = { kind: 'unreadable', raw: previous.raw, crlf: previous.crlf };
      }
      current.lines.push(inComment ? { kind: 'unreadable', raw: line, crlf } : parseSectionLine({ raw: line, crlf }));
      inComment = line.lastIndexOf('<!--') > line.lastIndexOf('-->') || (inComment && !line.includes('-->'));
    }
  }
  return { preamble, sections };
}

// A line is the person's own hand edit only when it has no hidden comment, opening or closing: a comment
// that fails to read as a fact marker (typo, unknown key, bad date, wrapped onto another line) must never pass as their words.
function parseSectionLine({ raw, crlf }: { raw: string; crlf: boolean }): PageLine {
  if (!BULLET_PREFIX_PATTERN.test(raw)) {
    return hasCommentMark(raw) ? { kind: 'unreadable', raw, crlf } : { kind: 'other', raw, crlf };
  }
  const { text, marker } = splitFactMarker(raw);
  // The space lets a bullet with nothing after the dash lose its prefix too.
  const body = `${text} `.replace(BULLET_PREFIX_PATTERN, '').trim();
  const fact = marker === undefined ? undefined : PageFactSchema.safeParse({ text: body, marker });
  if (fact?.success) {
    return { kind: 'fact', fact: fact.data, raw, crlf };
  }
  const handWritten = !hasCommentMark(raw) && (body === '' || PageFactTextSchema.safeParse(body).success);
  return handWritten ? { kind: 'other', raw, crlf } : { kind: 'unreadable', raw, crlf };
}
