/**
 * Pages: one Markdown file per person (`people/<slug>.md`) or matter (`matters/<slug>.md`)
 * inside a vault.
 *
 * Canonical owner of the page format. Reading never fails: any text is a page, however oddly shaped.
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

import { FactMarkerSchema, splitFactMarker } from './memoryNotes';
import { isPageSlug } from './pageSlug';

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
export const PageFrontMatterSchema = z.discriminatedUnion('kind', [PersonFrontMatterSchema, MatterFrontMatterSchema]);
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
  .min(1, 'A fact cannot be empty. Write a few words and try again.')
  .refine(text => !LINE_BREAK_PATTERN.test(text), 'A fact must be one line. Remove the line breaks and try again.')
  .refine(text => !text.includes('<!--'), 'A fact cannot contain "<!--". Remove it and try again.');

/** One fact bullet: its text without the leading `- ` and without the marker, plus the marker. */
const PageFactSchema = z.object({ text: PageFactTextSchema, marker: FactMarkerSchema });
type PageFact = z.infer<typeof PageFactSchema>;

/**
 * One line of a page body. A `fact` line is a bullet that ends with a readable fact marker. An
 * `unreadable` line is a bullet that carries a hidden comment (or text that cannot stand as a
 * fact) but no readable marker: it fails closed as unconfirmed, never as the person's own words.
 * Everything else (blank lines, prose, a bullet with no comment, an indented note) is `other`.
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

/** What a parser needs when the page carries no usable front matter: where it was found and what to call it. */
interface PageParseFallback {
  kind: PageKind;
  title: string;
}

/**
 * Reads a page from its text. Never throws: a page with no front matter, a broken YAML block,
 * no headings, or bullets with no marker is still a page. The front matter is the lines
 * between a first line `---` and the next line `---` (both exact, after dropping a trailing
 * `\r`); with no closing fence there is no front matter and every line is body. A block that
 * does not parse, or parses to something other than a map, is treated as
 * missing. A known key whose value does not fit the schema takes its fallback (`kind` and
 * `title` from `fallback`, the rest their defaults); unknown keys are ignored. The `# ` heading
 * line is never consulted for the title, so a hand-edited heading does not rename the page.
 */
export function parseMemoryPage({ content, fallback }: { content: string; fallback: PageParseFallback }): MemoryPage {
  const text = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  const split = text.split('\n');
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

/** The `.md` files in a vault's page folders that `listMemoryPages` skips because the name is not a page slug, as `folder/file.md`. */
export async function listSkippedPageFiles(vaultDir: string): Promise<string[]> {
  const skipped: string[] = [];
  for (const kind of PAGE_KINDS) {
    const names = await listFolderMarkdownNames(path.join(vaultDir, PAGE_FOLDERS[kind]));
    skipped.push(...names.filter(name => !isPageSlug(name)).map(name => `${PAGE_FOLDERS[kind]}/${name}.md`));
  }
  return skipped;
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

const FENCE = '---';
const BOM = '\uFEFF';
const BULLET_PREFIX_PATTERN = /^\s*[-*]\s+/;
const UNMARKED_BULLET_PATTERN = /^\s*[-*]\s+\S/;

/** The text of a bullet the person typed by hand, or undefined for any other line. */
export function unmarkedBulletText(raw: string): string | undefined {
  return UNMARKED_BULLET_PATTERN.test(raw) ? raw.replace(BULLET_PREFIX_PATTERN, '').trimEnd() : undefined;
}

function isFenceLine(line: string): boolean {
  return line.replace(/\r$/, '') === FENCE;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function listFolderMarkdownNames(folder: string): Promise<string[]> {
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
    .sort((a, b) => (a < b ? -1 : 1));
}

async function listFolderSlugs(folder: string): Promise<string[]> {
  return (await listFolderMarkdownNames(folder)).filter(isPageSlug);
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
  const parsedKind = PageKindSchema.safeParse(values['kind']);
  const kind = parsedKind.success ? parsedKind.data : fallback.kind;
  const parsedTitle = PersonFrontMatterSchema.shape.title.safeParse(values['title']);
  const title = parsedTitle.success ? parsedTitle.data : fallback.title;
  const parsedAliases = PersonFrontMatterSchema.shape.aliases.safeParse(values['aliases']);
  const aliases = parsedAliases.success ? parsedAliases.data : [];

  if (kind === 'person') {
    const parsedHousehold = PersonFrontMatterSchema.shape.household.safeParse(values['household']);
    return { kind, title, aliases, household: parsedHousehold.success ? parsedHousehold.data : false };
  }
  const parsedStatus = MatterFrontMatterSchema.shape.status.safeParse(values['status']);
  return { kind, title, aliases, status: parsedStatus.success ? parsedStatus.data : 'active' };
}

function parseBody(lines: string[]): { preamble: string[]; sections: PageSectionBlock[] } {
  const preamble: string[] = [];
  const sections: PageSectionBlock[] = [];
  let current: PageSectionBlock | undefined;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.slice('## '.length).trim();
      const parsedName = PageSectionSchema.safeParse(heading);
      current = { name: parsedName.success ? parsedName.data : undefined, heading, lines: [] };
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
    return { kind: 'fact', fact: fact.data };
  }
  const handWritten = !raw.includes('<!--') && (body === '' || PageFactTextSchema.safeParse(body).success);
  return handWritten ? { kind: 'other', raw } : { kind: 'unreadable', raw };
}
