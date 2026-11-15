/**
 * The alias index: every page's title and aliases, keyed for matching, so a turn can find the
 * people and matters a message names. Stored in `.memory-state/aliases.json` as a cache
 * that is rebuilt whenever any page's content hash differs from the one recorded.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  listMemoryPages,
  PageKindSchema,
  pagePath,
  readMemoryPage,
  type MemoryPage,
  type PageKind,
  type PageListing,
} from './memoryPages';
import { foldName } from './pageSlug';

/** The cache file. Keys are stored, so snake_case. */
export const ALIAS_INDEX_FILE = path.join('.memory-state', 'aliases.json');

const AliasIndexPageSchema = z.object({
  kind: PageKindSchema,
  slug: z.string(),
  title: z.string(),
  /** Hex SHA-256 of the page file's bytes when the entry was built. */
  content_hash: z.string(),
  aliases: z.array(z.string()),
});
type AliasIndexPage = z.infer<typeof AliasIndexPageSchema>;

const AliasIndexFileSchema = z.object({
  version: z.literal(1),
  pages: z.array(AliasIndexPageSchema),
});
export type AliasIndexFile = z.infer<typeof AliasIndexFileSchema>;

/** One page's match in a message. `possessive` when every hit was `<alias>'s` (the alias as owner, not subject). */
export interface AliasMatch {
  kind: PageKind;
  slug: string;
  title: string;
  /** The alias as listed on the page. */
  alias: string;
  possessive: boolean;
  /** Offset of the first hit in the normalized text, for ordering by where a name first appears. */
  position: number;
}

/**
 * Text as compared: folded as `foldName` does (lowercase, Latin accents dropped, other scripts kept
 * whole), curly apostrophes made straight, every character other than letters, marks, digits,
 * `@`, `.`, and `'` turned into one space, surrounding
 * space trimmed. Keeps an email address one token. Apostrophes survive only inside a word and
 * as a possessive ending (`'s`, or a bare `'` after an `s`), so quotes around a word fall away.
 */
export function normalizeAliasText(text: string): string {
  return foldName(text)
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}@.']+/gu, ' ')
    .split(' ')
    .map(trimApostrophes)
    .filter(token => token !== '')
    .join(' ');
}

function trimApostrophes(token: string): string {
  const core = token.replace(/^'+/, '').replace(/'+$/, '');
  const hadTrailing = token.replace(/^'+/, '').length > core.length;
  return hadTrailing && core.endsWith('s') ? `${core}'` : core;
}

interface Token {
  token: string;
  offset: number;
}

interface AliasHit {
  position: number;
  possessive: boolean;
  alias: string;
}

type HashedListing = PageListing & { contentHash: string };

function tokenize(normalized: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  for (const part of normalized.split(' ')) {
    if (part !== '') {
      tokens.push({ token: part, offset });
    }
    offset += part.length + 1;
  }
  return tokens;
}

function stripTrailingDot(token: string): string {
  return token.endsWith('.') ? token.slice(0, -1) : token;
}

function tokenMatch({
  messageToken,
  candidateToken,
  isLast,
}: {
  messageToken: string;
  candidateToken: string;
  isLast: boolean;
}): 'direct' | 'possessive' | undefined {
  const message = stripTrailingDot(messageToken);
  const candidate = stripTrailingDot(candidateToken);
  if (message === candidate) {
    return 'direct';
  }
  if (isLast && (message === `${candidate}'s` || (candidate.endsWith('s') && message === `${candidate}'`))) {
    return 'possessive';
  }
  return undefined;
}

function hitAt({
  messages,
  start,
  candidate,
}: {
  messages: Token[];
  start: number;
  candidate: string[];
}): 'direct' | 'possessive' | undefined {
  let possessive = false;
  for (const [k, candidateToken] of candidate.entries()) {
    const messageToken = messages[start + k];
    if (messageToken === undefined) {
      return undefined;
    }
    const kind = tokenMatch({ messageToken: messageToken.token, candidateToken, isLast: k === candidate.length - 1 });
    if (kind === undefined) {
      return undefined;
    }
    if (kind === 'possessive') {
      possessive = true;
    }
  }
  return possessive ? 'possessive' : 'direct';
}

// Scripts written without spaces between words: a name in them sits inside a longer run of text.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

interface SpanHit extends AliasHit {
  end: number;
}

function substringHits({
  normalizedText,
  normalizedCandidate,
  alias,
}: {
  normalizedText: string;
  normalizedCandidate: string;
  alias: string;
}): SpanHit[] {
  const hits: SpanHit[] = [];
  for (
    let at = normalizedText.indexOf(normalizedCandidate);
    at !== -1;
    at = normalizedText.indexOf(normalizedCandidate, at + 1)
  ) {
    // A mark right after the hit belongs to the last letter of the hit, so the text names someone else.
    if (!/^\p{M}/u.test(normalizedText.slice(at + normalizedCandidate.length))) {
      hits.push({ position: at, end: at + normalizedCandidate.length, possessive: false, alias });
    }
  }
  return hits;
}

function earliestHit(hits: AliasHit[]): AliasHit | undefined {
  return hits.reduce<AliasHit | undefined>(
    (best, hit) => (best === undefined || hit.position < best.position ? hit : best),
    undefined,
  );
}

/**
 * Pages whose title or an alias appears in `text` as whole words (anywhere in the text for a
 * name in a script written without spaces, such as Chinese, Japanese, Korean or Thai, where the longest
 * name in the index wins a span), case- and accent-
 * insensitive, with punctuation around a hit ignored (`(Nora)`, `Nora,`, `Nora!`) and a
 * trailing `.` on an alias or a word ignored (`W.` finds `W.` and `W`). A hit followed by
 * `'s` (or a bare `'` after an `s`, as in `James' car`) is possessive. One match per page: the earliest hit, and a direct hit anywhere wins
 * over a possessive one. Results are ordered by `position`.
 */
export function matchAliases({ index, text }: { index: AliasIndexFile; text: string }): AliasMatch[] {
  const normalizedText = normalizeAliasText(text);
  const messages = tokenize(normalizedText);
  const hitsByPage = new Map<AliasIndexPage, AliasHit[]>();
  const spans: { page: AliasIndexPage; hit: SpanHit }[] = [];
  for (const page of index.pages) {
    const hits: AliasHit[] = [];
    hitsByPage.set(page, hits);
    for (const candidate of [page.title, ...page.aliases]) {
      const normalizedCandidate = normalizeAliasText(candidate);
      const candidateTokens = tokenize(normalizedCandidate).map(entry => entry.token);
      if (candidateTokens.length === 0) {
        continue;
      }
      if (UNSPACED_SCRIPT.test(normalizedCandidate)) {
        spans.push(
          ...substringHits({ normalizedText, normalizedCandidate, alias: candidate }).map(hit => ({ page, hit })),
        );
        continue;
      }
      for (let start = 0; start + candidateTokens.length <= messages.length; start++) {
        const kind = hitAt({ messages, start, candidate: candidateTokens });
        const message = messages[start];
        if (kind !== undefined && message !== undefined) {
          hits.push({ position: message.offset, possessive: kind === 'possessive', alias: candidate });
        }
      }
    }
  }
  // Without spaces a short name can sit inside a longer one (นิด in นิดา): the longest name in the index takes the span.
  for (const { page, hit } of spans) {
    const length = hit.end - hit.position;
    const swallowed = spans.some(
      other =>
        other.hit.position <= hit.position && other.hit.end >= hit.end && other.hit.end - other.hit.position > length,
    );
    if (!swallowed) {
      hitsByPage.get(page)?.push(hit);
    }
  }
  const matches: AliasMatch[] = [];
  for (const page of index.pages) {
    const hits = hitsByPage.get(page) ?? [];
    const earliest = earliestHit(hits);
    if (earliest === undefined) {
      continue;
    }
    const earliestDirect = earliestHit(hits.filter(hit => !hit.possessive)) ?? earliest;
    matches.push({
      kind: page.kind,
      slug: page.slug,
      title: page.title,
      alias: earliestDirect.alias,
      possessive: hits.every(hit => hit.possessive),
      position: earliest.position,
    });
  }
  return matches.sort((a, b) => a.position - b.position);
}

/**
 * The pages that go by exactly this name: their title or one of their other names, compared the way names are
 * everywhere (case, accents and punctuation ignored). Unlike `matchAliases` the whole name must match, not a word
 * inside a longer text. Optionally only one kind.
 */
export function pagesNamed({
  index,
  name,
  kind,
}: {
  index: AliasIndexFile;
  name: string;
  kind: PageKind | undefined;
}): PageListing[] {
  const wanted = normalizeAliasText(name);
  if (wanted === '') {
    return [];
  }
  return index.pages
    .filter(page => kind === undefined || page.kind === kind)
    .filter(page => [page.title, ...page.aliases].some(candidate => normalizeAliasText(candidate) === wanted))
    .map(page => ({ kind: page.kind, slug: page.slug }));
}

/** An index entry for one page, from its parsed content and the hash of its bytes. */
function aliasIndexPage(input: {
  kind: PageKind;
  slug: string;
  page: MemoryPage;
  contentHash: string;
}): AliasIndexPage {
  return {
    kind: input.kind,
    slug: input.slug,
    title: input.page.frontMatter.title,
    content_hash: input.contentHash,
    aliases: input.page.frontMatter.aliases,
  };
}

/**
 * The vault's alias index, rebuilt when it is missing, unreadable, or any page's bytes have
 * changed since it was written (a page added, removed, or edited by anyone). A page whose size and
 * modification time are unchanged since it was last hashed is not read again. A rebuild reads
 * every page. With `persist` it also writes the file back by temp file plus rename; callers pass
 * it only for vaults the scope can write, so a read never creates or changes a vault. A vault with
 * no `people/` or `matters/` folder gives an empty index and writes nothing. A stale read only costs a
 * rebuild on the next call.
 */
export async function loadAliasIndex({
  vaultDir,
  persist = false,
}: {
  vaultDir: string;
  persist?: boolean | undefined;
}): Promise<AliasIndexFile> {
  if (!(await hasPageFolder(vaultDir))) {
    return { version: 1, pages: [] };
  }
  const listings = await hashedListings({ vaultDir });
  const cached = await readCachedIndex({ vaultDir });
  if (cached !== undefined && sameEntries({ cached: cached.pages, listings })) {
    return cached;
  }

  const pages: AliasIndexPage[] = [];
  for (const listing of listings) {
    const page = await readMemoryPage({ vaultDir, kind: listing.kind, slug: listing.slug });
    if (page !== undefined) {
      pages.push(aliasIndexPage({ kind: listing.kind, slug: listing.slug, page, contentHash: listing.contentHash }));
    }
  }
  const index: AliasIndexFile = { version: 1, pages };
  if (persist) {
    await writeAliasIndex({ vaultDir, index });
  }
  return index;
}

async function hasPageFolder(vaultDir: string): Promise<boolean> {
  for (const folder of ['people', 'matters']) {
    try {
      if ((await stat(path.join(vaultDir, folder))).isDirectory()) {
        return true;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
  return false;
}

function indexPath(vaultDir: string): string {
  return path.join(vaultDir, ALIAS_INDEX_FILE);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** A page file's hash, kept with the stat fields that were current when it was computed. */
interface HashedFile {
  mtimeNs: bigint;
  /** Change time, which a program cannot set back, so an edit that restores `mtime` still shows. */
  ctimeNs: bigint;
  size: bigint;
  ino: bigint;
  /** When the hash was computed, in milliseconds. */
  hashedAtMs: number;
  contentHash: string;
}

/**
 * File timestamps can be coarse, so a file changed within this long of its last recorded change
 * could change again without its stat differing. Such a file is hashed again each time until it
 * has been quiet for longer than this.
 */
const STAT_QUIET_MS = 2000;

/** Vaults whose hashes are kept; the least recently read vault is dropped past this. */
const MAX_CACHED_VAULTS = 64;

/** Hashes by vault, then by page file, so a turn only touches the vaults it reads. */
const hashedVaults = new Map<string, Map<string, HashedFile>>();

function vaultHashes(vaultDir: string): Map<string, HashedFile> {
  const known = hashedVaults.get(vaultDir);
  const files = known ?? new Map<string, HashedFile>();
  // Re-inserting keeps the map in least-recently-read order.
  hashedVaults.delete(vaultDir);
  hashedVaults.set(vaultDir, files);
  for (const oldest of hashedVaults.keys()) {
    if (hashedVaults.size <= MAX_CACHED_VAULTS) {
      break;
    }
    hashedVaults.delete(oldest);
  }
  return files;
}

/** The hash of a page file, read again only when its stat differs from the one the hash was taken at. */
async function fileHash({
  files,
  file,
}: {
  files: Map<string, HashedFile>;
  file: string;
}): Promise<string | undefined> {
  let info: BigIntStats;
  try {
    info = await stat(file, { bigint: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  const known = files.get(file);
  if (
    known?.mtimeNs === info.mtimeNs &&
    known.ctimeNs === info.ctimeNs &&
    known.size === info.size &&
    known.ino === info.ino &&
    known.hashedAtMs - Number(info.ctimeNs / 1_000_000n) > STAT_QUIET_MS
  ) {
    return known.contentHash;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  files.set(file, {
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    size: info.size,
    ino: info.ino,
    hashedAtMs: Date.now(),
    contentHash,
  });
  return contentHash;
}

async function hashedListings({ vaultDir }: { vaultDir: string }): Promise<HashedListing[]> {
  const listings: HashedListing[] = [];
  const files = vaultHashes(vaultDir);
  const present = new Set<string>();
  for (const listing of await listMemoryPages(vaultDir)) {
    const file = pagePath({ vaultDir, kind: listing.kind, slug: listing.slug });
    const contentHash = await fileHash({ files, file });
    if (contentHash !== undefined) {
      present.add(file);
      listings.push({ ...listing, contentHash });
    }
  }
  // Pages removed from this vault must not stay in memory.
  for (const file of files.keys()) {
    if (!present.has(file)) {
      files.delete(file);
    }
  }
  return listings;
}

async function readCachedIndex({ vaultDir }: { vaultDir: string }): Promise<AliasIndexFile | undefined> {
  let text: string;
  try {
    text = await readFile(indexPath(vaultDir), 'utf8');
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = AliasIndexFileSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function entryKey({ kind, slug, contentHash }: { kind: PageKind; slug: string; contentHash: string }): string {
  return JSON.stringify([kind, slug, contentHash]);
}

function sameEntries({ cached, listings }: { cached: AliasIndexPage[]; listings: HashedListing[] }): boolean {
  const cachedKeys = new Set(
    cached.map(page => entryKey({ kind: page.kind, slug: page.slug, contentHash: page.content_hash })),
  );
  const currentKeys = new Set(listings.map(listing => entryKey(listing)));
  return cachedKeys.size === currentKeys.size && [...currentKeys].every(key => cachedKeys.has(key));
}

async function writeAliasIndex({ vaultDir, index }: { vaultDir: string; index: AliasIndexFile }): Promise<void> {
  const target = indexPath(vaultDir);
  const stateDir = path.dirname(target);
  const temp = path.join(stateDir, `aliases.json.tmp-${randomUUID()}`);
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(temp, JSON.stringify(index), 'utf8');
    await rename(temp, target);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
