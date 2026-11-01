/**
 * The alias index: every page's title and aliases, keyed for matching, so a turn can find the
 * people and matters a message names. Stored in `.memory-state/aliases.json` as a cache
 * that is rebuilt whenever any page's content hash differs from the one recorded.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** The cache file. Keys are stored, so snake_case. */
export const ALIAS_INDEX_FILE = path.join('.memory-state', 'aliases.json');

export const AliasIndexPageSchema = z.object({
  kind: PageKindSchema,
  slug: z.string(),
  title: z.string(),
  /** Hex SHA-256 of the page file's bytes when the entry was built. */
  content_hash: z.string(),
  aliases: z.array(z.string()),
});
export type AliasIndexPage = z.infer<typeof AliasIndexPageSchema>;

export const AliasIndexFileSchema = z.object({
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
 * Text as compared: lowercase, accents folded away, every character other than letters,
 * digits, `@`, `.`, and `'` turned into one space, surrounding space trimmed. Keeps an
 * email address one token and keeps possessives recognisable.
 */
export function normalizeAliasText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.']+/gu, ' ')
    .trim();
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
  if (isLast && message === `${candidate}'s`) {
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

function earliestHit(hits: AliasHit[]): AliasHit | undefined {
  return hits.reduce<AliasHit | undefined>(
    (best, hit) => (best === undefined || hit.position < best.position ? hit : best),
    undefined,
  );
}

/**
 * Pages whose title or an alias appears in `text` as whole words, case- and accent-
 * insensitive, with punctuation around a hit ignored (`(Wendy)`, `Wendy,`, `Wendy!`) and a
 * trailing `.` on an alias or a word ignored (`W.` finds `W.` and `W`). A hit followed by
 * `'s` is possessive. One match per page: the earliest hit, and a direct hit anywhere wins
 * over a possessive one. Results are ordered by `position`.
 */
export function matchAliases({ index, text }: { index: AliasIndexFile; text: string }): AliasMatch[] {
  const messages = tokenize(normalizeAliasText(text));
  const matches: AliasMatch[] = [];
  for (const page of index.pages) {
    const hits: AliasHit[] = [];
    for (const candidate of [page.title, ...page.aliases]) {
      const candidateTokens = tokenize(normalizeAliasText(candidate)).map(entry => entry.token);
      if (candidateTokens.length === 0) {
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

/** An index entry for one page, from its parsed content and the hash of its bytes. */
export function aliasIndexPage(input: {
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
 * changed since it was written (a page added, removed, or edited by anyone). A rebuild reads
 * every page and writes the file back by temp file plus rename. The caller need not hold the
 * vault lock: a stale read only costs a rebuild on the next call.
 */
export async function loadAliasIndex({ vaultDir }: { vaultDir: string }): Promise<AliasIndexFile> {
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
  await writeAliasIndex({ vaultDir, index });
  return index;
}

function indexPath(vaultDir: string): string {
  return path.join(vaultDir, ALIAS_INDEX_FILE);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function hashedListings({ vaultDir }: { vaultDir: string }): Promise<HashedListing[]> {
  const listings: HashedListing[] = [];
  for (const listing of await listMemoryPages(vaultDir)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(pagePath({ vaultDir, kind: listing.kind, slug: listing.slug }));
    } catch (error) {
      if (isMissingFile(error)) {
        continue;
      }
      throw error;
    }
    listings.push({ ...listing, contentHash: createHash('sha256').update(bytes).digest('hex') });
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
