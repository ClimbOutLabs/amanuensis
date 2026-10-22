import { collectOutboundStrings } from '../permissions/outboundGuard';
import { namesUrl } from '../permissions/webSearch';
import { normalizedWords } from './groundPlace';
import { TAVILY_EXTRACT_TOOL_NAME, TAVILY_SEARCH_TOOL_NAME } from './TavilyClient';

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
  /** True when this is one search result's own text rather than a page read in full. */
  is_snippet: boolean;
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

/** Searches remembered per chat, and chats remembered at once, so the query check stays bounded. */
const MAX_QUERIES_PER_CHAT = 50;
const MAX_CHATS_WITH_QUERIES = 200;

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

function chatKey(scope: FetchedPageScope): string {
  return `${scope.tenant_id}\u0000${scope.conversation_id}\u0000`;
}

/** The store key of one page in one chat: the chat first, so no two chats ever share an entry. */
function storeKey({ scope, url }: { scope: FetchedPageScope; url: string }): string {
  return `${chatKey(scope)}${pageUrlKey(url)}`;
}

/** Whether the words appear, in order and side by side, inside the other words. */
function containsRun({ haystack, needle }: { haystack: readonly string[]; needle: readonly string[] }): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((word, offset) => haystack[at + offset] === word)) {
      return true;
    }
  }
  return false;
}

function wordsOf(text: string): string[] {
  const words = normalizedWords(text).trim();
  return words === '' ? [] : words.split(' ');
}

export class FetchedPageStore {
  readonly #pages = new Map<string, FetchedPage & { expires_at: number }>();
  /** Each chat's search queries, as words. A snippet never outlives the queries of its chat. */
  readonly #queries = new Map<string, { queries: string[][]; expires_at: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPages: number;

  constructor(input: { now: () => number; ttlMs: number; maxPages: number }) {
    this.#now = input.now;
    this.#ttlMs = input.ttlMs;
    this.#maxPages = input.maxPages;
  }

  /** A page the person's read tool returned. It replaces any search snippet kept for the same link. */
  remember({ scope, url, text }: { scope: FetchedPageScope; url: string; text: string }): FetchedPage {
    return this.#store({ scope, url, text, is_snippet: false });
  }

  /**
   * A search result's own text, kept as a source. It never replaces a page already read for the same
   * link, so a snippet cannot weaken a page.
   */
  rememberSnippet({ scope, url, text }: { scope: FetchedPageScope; url: string; text: string }): FetchedPage {
    const existing = this.#live({ scope, url });
    if (existing !== undefined && !existing.is_snippet) {
      return existing;
    }
    return this.#store({ scope, url, text, is_snippet: true });
  }

  #store({
    scope,
    url,
    text,
    is_snippet,
  }: {
    scope: FetchedPageScope;
    url: string;
    text: string;
    is_snippet: boolean;
  }): FetchedPage {
    const now = this.#now();
    const page: FetchedPage = { url, text, fetched_at: new Date(now).toISOString(), is_snippet };
    if (url.length > MAX_STORED_URL_CHARS) {
      return page;
    }
    const key = storeKey({ scope, url });
    this.#pages.delete(key);
    this.#pages.set(key, { ...page, expires_at: now + this.#ttlMs });
    while (this.#pages.size > this.#maxPages) {
      const victim = this.#evictionVictim();
      if (victim === undefined) {
        break;
      }
      this.#pages.delete(victim);
    }
    return page;
  }

  /** Snippets go first, so a search never pushes out a page a person's read tool fetched. */
  #evictionVictim(): string | undefined {
    for (const [key, stored] of this.#pages) {
      if (stored.is_snippet) {
        return key;
      }
    }
    return this.#pages.keys().next().value;
  }

  #live({ scope, url }: { scope: FetchedPageScope; url: string }): FetchedPage | undefined {
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
    return { url: stored.url, text: stored.text, fetched_at: stored.fetched_at, is_snippet: stored.is_snippet };
  }

  recall({ scope, url }: { scope: FetchedPageScope; url: string }): FetchedPage | undefined {
    return this.#live({ scope, url });
  }

  /** A search this chat ran, kept so a place copied from the query is never taken as found. */
  rememberQuery({ scope, query }: { scope: FetchedPageScope; query: string }): void {
    const words = wordsOf(query);
    if (words.length === 0) {
      return;
    }
    const key = chatKey(scope);
    const entry = this.#liveQueries(key) ?? { queries: [], expires_at: 0 };
    this.#queries.delete(key);
    entry.queries.push(words);
    entry.expires_at = this.#now() + this.#ttlMs;
    if (entry.queries.length > MAX_QUERIES_PER_CHAT) {
      // A dropped query could have produced a kept snippet, so that chat's snippets go with it.
      entry.queries.splice(0, entry.queries.length - MAX_QUERIES_PER_CHAT);
      this.#dropSnippets(key);
    }
    this.#queries.set(key, entry);
    while (this.#queries.size > MAX_CHATS_WITH_QUERIES) {
      const oldest = this.#queries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#queries.delete(oldest);
      this.#dropSnippets(oldest);
    }
  }

  /** Whether any search this chat ran holds these words side by side. */
  queriesContain({ scope, text }: { scope: FetchedPageScope; text: string }): boolean {
    const needle = wordsOf(text);
    const entry = this.#liveQueries(chatKey(scope));
    return entry?.queries.some(query => containsRun({ haystack: query, needle })) === true;
  }

  #liveQueries(key: string): { queries: string[][]; expires_at: number } | undefined {
    const entry = this.#queries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expires_at <= this.#now()) {
      this.#queries.delete(key);
      this.#dropSnippets(key);
      return undefined;
    }
    return entry;
  }

  #dropSnippets(chat: string): void {
    for (const [key, stored] of this.#pages) {
      if (stored.is_snippet && key.startsWith(chat)) {
        this.#pages.delete(key);
      }
    }
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
 * The tools whose results are a list of search hits, by name. Only these record snippets: a page
 * reader's output links to pages it never showed, so its results are never search hits.
 */
const SEARCH_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  TAVILY_SEARCH_TOOL_NAME,
  'web_search',
  'web_search_exa',
  'web_search_advanced_exa',
]);

/** Whether a tool's results may be recorded one search hit at a time. */
export function isSearchResultTool(name: string): boolean {
  return SEARCH_RESULT_TOOL_NAMES.has(name) && !PAGE_READER_TOOL_NAMES.has(name);
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

/**
 * The words one search result carries about itself: its title, its snippet, and any page text it
 * has. Only these fields, so a provider's summary or the call's own query never reaches the store.
 */
function searchResultTextOf(record: Record<string, unknown>): string | undefined {
  const parts = [stringField(record, 'title'), stringField(record, 'snippet'), pageTextOf(record)].filter(
    (part): part is string => part !== undefined,
  );
  const unique = [...new Set(parts)];
  return unique.length === 0 ? undefined : unique.join('\n');
}

/** A result that repeats this many query words side by side is an echo of the search, not a source. */
const QUERY_ECHO_RUN_WORDS = 3;

/** Every run of QUERY_ECHO_RUN_WORDS words in the call's text arguments. */
function queryRuns(queries: readonly string[]): string[][] {
  const runs: string[][] = [];
  for (const query of queries) {
    const words = wordsOf(query);
    for (let at = 0; at + QUERY_ECHO_RUN_WORDS <= words.length; at += 1) {
      runs.push(words.slice(at, at + QUERY_ECHO_RUN_WORDS));
    }
  }
  return runs;
}

/**
 * Records each result a search tool returned as a source, keyed by that result's own link. Only the
 * results list counts: the query, a result that repeats it, and any answer a provider wrote are never
 * recorded. A call whose arguments name a link fetched something, so nothing from it is recorded.
 * A snippet only fills in a link no page read has covered. Returns how many results were recorded.
 */
export function recordSearchResults(input: {
  pages: FetchedPageStore;
  scope: FetchedPageScope;
  toolArguments: unknown;
  texts: readonly string[];
}): number {
  const sent = collectOutboundStrings(input.toolArguments);
  if (sent === undefined || namesUrl(sent.values)) {
    return 0;
  }
  for (const query of sent.values) {
    input.pages.rememberQuery({ scope: input.scope, query });
  }
  const echoes = queryRuns(sent.values);
  let recorded = 0;
  for (const text of input.texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['results'])) {
      continue;
    }
    for (const item of parsed['results']) {
      if (!isRecord(item)) {
        continue;
      }
      const url = stringField(item, 'url');
      const resultText = searchResultTextOf(item);
      if (url === undefined || resultText === undefined || url.length > MAX_STORED_URL_CHARS) {
        continue;
      }
      const resultWords = wordsOf(resultText);
      if (echoes.some(run => containsRun({ haystack: resultWords, needle: run }))) {
        continue;
      }
      input.pages.rememberSnippet({
        scope: input.scope,
        url,
        text: resultText.slice(0, FETCHED_PAGE_TEXT_MAX_CHARS),
      });
      recorded += 1;
    }
  }
  return recorded;
}
