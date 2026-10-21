import { TAVILY_EXTRACT_TOOL_NAME } from './TavilyClient';

/**
 * Short-lived server memory of the pages any page reading tool returned, so a place claim can be
 * checked against the text the model actually saw. Kept per chat, because a held call resumes in
 * a new turn of the same chat and a per-turn memory would be gone by then, and because one chat
 * must never be checked against a page another chat read. The text is public page content, never
 * stored on disk and never logged.
 */
export interface FetchedPage {
  url: string;
  text: string;
  /** Stamped here, from the server clock. */
  fetched_at: string;
}

/** The tenant and chat a page was read in; a stored page is only visible inside that one chat. */
export interface FetchedPageScope {
  tenant_id: string;
  conversation_id: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PAGES = 50;

/** Longest page text kept for checking a place claim; the same bound the Tavily reader hands the model. */
export const FETCHED_PAGE_TEXT_MAX_CHARS = 8000;

/** Longest link kept as a store key. A longer link is not recorded; a page a person reads has a far shorter one. */
const MAX_STORED_URL_CHARS = 2048;

/**
 * The key a page is stored and looked up under. Spellings that reach the same page count as one:
 * http and https, host name case and one trailing slash on the path. A different path or query is
 * a different page, so a made up link still misses.
 */
function pageUrlKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const scheme = url.protocol === 'http:' || url.protocol === 'https:' ? 'https:' : url.protocol;
  const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${scheme}//${url.hostname.toLowerCase()}${port}${path}${url.search}`;
}

/** The store key of one page in one chat: the chat first, so no two chats ever share an entry. */
function storeKey({ scope, url }: { scope: FetchedPageScope; url: string }): string {
  return `${scope.tenant_id}\u0000${scope.conversation_id}\u0000${pageUrlKey(url)}`;
}

export class FetchedPageStore {
  readonly #pages = new Map<string, FetchedPage & { expires_at: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPages: number;

  constructor(input: { now: () => number; ttlMs: number; maxPages: number }) {
    this.#now = input.now;
    this.#ttlMs = input.ttlMs;
    this.#maxPages = input.maxPages;
  }

  remember({ scope, url, text }: { scope: FetchedPageScope; url: string; text: string }): FetchedPage {
    const now = this.#now();
    const page: FetchedPage = { url, text, fetched_at: new Date(now).toISOString() };
    if (url.length > MAX_STORED_URL_CHARS) {
      return page;
    }
    const key = storeKey({ scope, url });
    this.#pages.delete(key);
    this.#pages.set(key, { ...page, expires_at: now + this.#ttlMs });
    while (this.#pages.size > this.#maxPages) {
      const oldest = this.#pages.keys().next();
      if (oldest.done) {
        break;
      }
      this.#pages.delete(oldest.value);
    }
    return page;
  }

  recall({ scope, url }: { scope: FetchedPageScope; url: string }): FetchedPage | undefined {
    if (url.length > MAX_STORED_URL_CHARS) {
      return undefined;
    }
    const key = storeKey({ scope, url });
    const stored = this.#pages.get(key);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.expires_at <= this.#now()) {
      this.#pages.delete(key);
      return undefined;
    }
    return { url: stored.url, text: stored.text, fetched_at: stored.fetched_at };
  }
}

/** The one memory the page reading tools write and the pin tool reads. */
export const fetchedPages = new FetchedPageStore({
  now: Date.now,
  ttlMs: DEFAULT_TTL_MS,
  maxPages: DEFAULT_MAX_PAGES,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Argument names that hand a tool the page to read, so the link is the call's target. A link
 * anywhere else in the arguments, above all in a search's text, names no page: the call did not
 * read it, so its text must not be recorded as read.
 */
const PAGE_ARGUMENT_KEYS = new Set(['url', 'urls']);

/**
 * Every link a tool call named as a page to read, at any depth of its arguments. A call that
 * names no link read no page.
 */
function namedUrls(value: unknown, into: Map<string, string>, depth: number, key: string | undefined): void {
  if (depth > 6) {
    return;
  }
  if (typeof value === 'string') {
    if (key !== undefined && PAGE_ARGUMENT_KEYS.has(key.toLowerCase())) {
      const trimmed = value.trim();
      if (/^https?:\/\/\S+$/i.test(trimmed)) {
        into.set(pageUrlKey(trimmed), trimmed);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      namedUrls(item, into, depth + 1, key);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, item] of Object.entries(value)) {
      namedUrls(item, into, depth + 1, childKey);
    }
  }
}

/** Keys whose contents describe a page or what it links to, never a fetched page of this result itself. */
const NON_PAGE_KEYS = new Set(['links', 'metadata', 'images', 'favicon']);

/** The page text a result item carries, longest first: full text, then content, then excerpts joined. */
function pageTextOf(record: Record<string, unknown>): string | undefined {
  const direct = [stringField(record, 'text'), stringField(record, 'raw_content'), stringField(record, 'content')]
    .filter((value): value is string => value !== undefined)
    .sort((a, b) => b.length - a.length)[0];
  if (direct !== undefined) {
    return direct;
  }
  const excerpts = record['excerpts'];
  if (Array.isArray(excerpts)) {
    const joined = excerpts.filter((item): item is string => typeof item === 'string').join('\n\n');
    return joined === '' ? undefined : joined;
  }
  return undefined;
}

function collectPages(node: unknown, into: { url: string; text: string }[], depth: number): void {
  if (depth > 6) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPages(item, into, depth + 1);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const url = stringField(node, 'url');
  const text = pageTextOf(node);
  if (url !== undefined && text !== undefined) {
    into.push({ url, text });
  }
  for (const [key, value] of Object.entries(node)) {
    if (!NON_PAGE_KEYS.has(key)) {
      collectPages(value, into, depth + 1);
    }
  }
}

/**
 * The tools that read a page for the person, by name. Only these record what they return: any other
 * tool may echo the link it was given, or any text, and a page that tool never read must not count.
 */
const PAGE_READER_TOOL_NAMES: ReadonlySet<string> = new Set(['web_fetch', TAVILY_EXTRACT_TOOL_NAME]);

/** Whether a tool reads a page, so its result may be recorded as page text. */
export function isPageReaderTool(name: string): boolean {
  return PAGE_READER_TOOL_NAMES.has(name);
}

/**
 * Records what a page reading tool actually read, so a later place claim can be checked against it.
 * Only a page the call itself named as the page to read counts: a search names no page, even when
 * its text is itself a link, and a page a result only links to was never read. The caller decides
 * which tools are page readers. Returns how many pages were recorded.
 */
export function recordFetchedPages(input: {
  pages: FetchedPageStore;
  scope: FetchedPageScope;
  toolArguments: unknown;
  texts: readonly string[];
}): number {
  const named = new Map<string, string>();
  namedUrls(input.toolArguments, named, 0, undefined);
  if (named.size === 0) {
    return 0;
  }
  const recorded = new Set<string>();
  for (const text of input.texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      // A plain text result is the body of the one page the call named.
      if (named.size === 1) {
        const only = [...named.values()][0];
        if (only !== undefined && only.length <= MAX_STORED_URL_CHARS && text.trim() !== '') {
          input.pages.remember({ scope: input.scope, url: only, text: text.slice(0, FETCHED_PAGE_TEXT_MAX_CHARS) });
          recorded.add(pageUrlKey(only));
        }
      }
      continue;
    }
    const candidates: { url: string; text: string }[] = [];
    collectPages(parsed, candidates, 0);
    for (const candidate of candidates) {
      const key = pageUrlKey(candidate.url);
      if (named.has(key) && !recorded.has(key) && candidate.url.length <= MAX_STORED_URL_CHARS) {
        input.pages.remember({
          scope: input.scope,
          url: candidate.url,
          text: candidate.text.slice(0, FETCHED_PAGE_TEXT_MAX_CHARS),
        });
        recorded.add(key);
      }
    }
  }
  return recorded.size;
}
