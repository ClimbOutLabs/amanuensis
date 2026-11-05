/**
 * Pages: one Markdown file per person (`people/<slug>.md`) or matter (`matters/<slug>.md`)
 * inside a vault.
 *
 * Canonical owner of the page format. Reading never fails: any text is a page, however oddly shaped.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

import { FactMarkerSchema, splitFactMarker } from './memoryNotes';
import { isPageSlug, UNTITLED_PAGE_SLUG } from './pageSlug';

const PAGE_KINDS = ['person', 'matter'] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKindSchema>;

/** The vault folder each kind of page lives in. */
const PAGE_FOLDERS: Readonly<Record<PageKind, string>> = { person: 'people', matter: 'matters' };

/** The sections a page may have. */
const PAGE_SECTIONS = ['How you write to them', 'Now', 'Decided', 'Open', 'Unconfirmed', 'Earlier'] as const;
const PageSectionSchema = z.enum(PAGE_SECTIONS);
export type PageSection = z.infer<typeof PageSectionSchema>;

const MatterStatusSchema = z.enum(['active', 'done']);

const pageFrontMatterBase = {
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
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

/**
 * The text of one fact: a single trimmed line that holds no hidden comment, so it renders as exactly
 * one bullet and its marker always lands on that same line.
 */
const PageFactTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine(text => !LINE_BREAK_PATTERN.test(text))
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
 */
export type PageLine =
  { kind: 'fact'; fact: PageFact } | { kind: 'other'; raw: string } | { kind: 'unreadable'; raw: string };

/**
 * A `## ` heading and the lines under it. `name` is set when the heading is one of
 * `PAGE_SECTIONS` (matched after trimming, case-sensitive); any other heading is kept as is.
 */
export interface PageSectionBlock {
  name: PageSection | undefined;
  /** The heading text without `## `; equals `name` for a known section. */
  heading: string;
  lines: PageLine[];
}

export interface MemoryPage {
  frontMatter: PageFrontMatter;
  /** Every line between the front matter and the first `## ` heading: the `# ` title line, the summary, blanks. */
  preamble: string[];
  sections: PageSectionBlock[];
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
  const text = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  // Windows line endings (`\r\n`) end a line the same way, so no line keeps a trailing `\r`.
  const split = text.split(/\r?\n/);
  const lines = text.endsWith('\n') ? split.slice(0, -1) : split;

  let values: Record<string, unknown> = {};
  let body = lines;
  const [first] = lines;
  if (first !== undefined && isFenceLine(first)) {
    const close = lines.findIndex((line, index) => index > 0 && isFenceLine(line));
    if (close !== -1) {
      const inner = lines.slice(1, close);
      values = readFrontMatterMap(inner);
      body = lines.slice(close + 1);
    }
  }

  const { preamble, sections } = parseBody(body);
  return { frontMatter: frontMatterFrom({ values, fallback }), preamble, sections };
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
const BOM = '\uFEFF';
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
  return line === FENCE;
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
  if (kind === 'person') {
    const household = PersonFrontMatterSchema.shape.household.catch(false).parse(values['household']);
    return PageFrontMatterSchema.parse({ kind, title, aliases, household });
  }
  const status = MatterFrontMatterSchema.shape.status.catch('active').parse(values['status']);
  return PageFrontMatterSchema.parse({ kind, title, aliases, status });
}

function parseBody(lines: string[]): { preamble: string[]; sections: PageSectionBlock[] } {
  const preamble: string[] = [];
  const sections: PageSectionBlock[] = [];
  let current: PageSectionBlock | undefined;
  // True while a hidden comment opened on an earlier line has not closed yet.
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.slice('## '.length).trim();
      const parsedName = PageSectionSchema.safeParse(heading);
      current = { name: parsedName.success ? parsedName.data : undefined, heading, lines: [] };
      sections.push(current);
      inComment = false;
    } else if (current === undefined) {
      preamble.push(line);
    } else {
      // A marker wrapped onto the next line leaves the bullet above it looking unmarked, so that bullet is not trusted.
      const previous = current.lines.at(-1);
      if (
        !inComment &&
        line.trimStart().startsWith('<!--') &&
        previous?.kind === 'other' &&
        unmarkedBulletText(previous.raw) !== undefined
      ) {
        current.lines[current.lines.length - 1] = { kind: 'unreadable', raw: previous.raw };
      }
      current.lines.push(inComment ? { kind: 'unreadable', raw: line } : parseSectionLine(line));
      inComment = line.lastIndexOf('<!--') > line.lastIndexOf('-->') || (inComment && !line.includes('-->'));
    }
  }
  return { preamble, sections };
}

// A line is the person's own hand edit only when it has no hidden comment, opening or closing: a comment
// that fails to read as a fact marker (typo, unknown key, bad date, wrapped onto another line) must never pass as their words.
function parseSectionLine(raw: string): PageLine {
  if (!BULLET_PREFIX_PATTERN.test(raw)) {
    return hasCommentMark(raw) ? { kind: 'unreadable', raw } : { kind: 'other', raw };
  }
  const { text, marker } = splitFactMarker(raw);
  // The space lets a bullet with nothing after the dash lose its prefix too.
  const body = `${text} `.replace(BULLET_PREFIX_PATTERN, '').trim();
  const fact = marker === undefined ? undefined : PageFactSchema.safeParse({ text: body, marker });
  if (fact?.success) {
    return { kind: 'fact', fact: fact.data };
  }
  const handWritten = !hasCommentMark(raw) && (body === '' || PageFactTextSchema.safeParse(body).success);
  return handWritten ? { kind: 'other', raw } : { kind: 'unreadable', raw };
}
