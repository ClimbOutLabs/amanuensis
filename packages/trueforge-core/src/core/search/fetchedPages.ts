import { collectOutboundStrings } from '../permissions/outboundGuard';
import { namesUrl } from '../permissions/webSearch';
import { hasMixedScriptWord, normalizedWords, significantWords } from './groundPlace';
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
  /** True for a search result, or a page read from a link a search of this chat returned. */
  from_search: boolean;
}

/** The tenant and chat a page was read in; a stored page is only visible inside that one chat. */
export interface FetchedPageScope {
  tenant_id: string;
  conversation_id: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PAGES = 50;

/** Longest page text kept for checking a place claim. Well above the page read budget (about 10,000 characters), so the full page fits. */
export const FETCHED_PAGE_TEXT_MAX_CHARS = 64_000;

/** Longest link kept as a store key. A longer link is not recorded; a page a person reads has a far shorter one. */
const MAX_STORED_URL_CHARS = 2048;

/** Searches remembered per chat, and chats remembered at once, so the query check stays bounded. */
const MAX_QUERIES_PER_CHAT = 50;
const MAX_CHATS_WITH_QUERIES = 200;
/** Result links remembered per chat: every search kept, at up to 20 results each. */
const MAX_RESULT_LINKS_PER_CHAT = MAX_QUERIES_PER_CHAT * 20;

/**
 * A claim is an echo when at least this share of its telling words are search words. Over half, so
 * a real place may share its town or one name word with the search, while a claim built mostly from
 * the search, in any order or with one word added, is refused.
 */
const QUERY_ECHO_SHARE = 0.6;

interface ChatSearches {
  queries: number;
  /** Every word of every search this chat ran. */
  words: Set<string>;
  /** Store keys of the links those searches returned. */
  result_links: Set<string>;
  /** A search had a word that mixes scripts, so its words cannot be compared; every claim counts as an echo. */
  has_mixed_script_word: boolean;
  expires_at: number;
}

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

function wordsOf(text: string): string[] {
  const words = normalizedWords(text).trim();
  return words === '' ? [] : words.split(' ');
}

export class FetchedPageStore {
  readonly #pages = new Map<string, FetchedPage & { expires_at: number }>();
  /**
   * Each chat's searches. A page from a search never outlives them, so it is always checked
   * against the searches it came from.
   */
  readonly #searches = new Map<string, ChatSearches>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPages: number;

  constructor(input: { now: () => number; ttlMs: number; maxPages: number }) {
    this.#now = input.now;
    this.#ttlMs = input.ttlMs;
    this.#maxPages = input.maxPages;
  }

  /**
   * A page the person's read tool returned. It replaces any search snippet kept for the same link.
   * A page read from a link a search of this chat returned is checked against that chat's searches.
   */
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
    const searches = this.#liveSearches(chatKey(scope));
    const from_search = is_snippet || searches?.result_links.has(pageUrlKey(url)) === true;
    const page: FetchedPage = { url, text, fetched_at: new Date(now).toISOString(), is_snippet, from_search };
    if (url.length > MAX_STORED_URL_CHARS) {
      return page;
    }
    const key = storeKey({ scope, url });
    this.#pages.delete(key);
    if (from_search && searches === undefined) {
      // A search result with no search left to check it against is never a source.
      return page;
    }
    const expires_at = Math.min(now + this.#ttlMs, searches?.expires_at ?? Number.POSITIVE_INFINITY);
    this.#pages.set(key, { ...page, expires_at });
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
    if (stored.expires_at <= this.#now() || (stored.from_search && this.#liveSearches(chatKey(scope)) === undefined)) {
      this.#pages.delete(key);
      return undefined;
    }
    return {
      url: stored.url,
      text: stored.text,
      fetched_at: stored.fetched_at,
      is_snippet: stored.is_snippet,
      from_search: stored.from_search,
    };
  }

  recall({ scope, url }: { scope: FetchedPageScope; url: string }): FetchedPage | undefined {
    return this.#live({ scope, url });
  }

  /** A search this chat ran, kept so a place copied from the search words is never taken as found. */
  rememberQuery({ scope, query }: { scope: FetchedPageScope; query: string }): void {
    const words = wordsOf(query);
    if (words.length === 0) {
      return;
    }
    const key = chatKey(scope);
    const entry = this.#liveSearches(key) ?? {
      queries: 0,
      words: new Set<string>(),
      result_links: new Set<string>(),
      has_mixed_script_word: false,
      expires_at: 0,
    };
    this.#searches.delete(key);
    entry.queries += 1;
    for (const word of words) {
      entry.words.add(word);
    }
    entry.expires_at = this.#now() + this.#ttlMs;
    if (entry.queries > MAX_QUERIES_PER_CHAT) {
      // Too many searches to keep: start that chat afresh, with nothing taken from the old ones.
      this.#dropFromSearch(key);
      entry.queries = 1;
      entry.words = new Set(words);
      entry.result_links.clear();
      entry.has_mixed_script_word = false;
    }
    entry.has_mixed_script_word ||= hasMixedScriptWord(query);
    this.#searches.set(key, entry);
    while (this.#searches.size > MAX_CHATS_WITH_QUERIES) {
      const oldest = this.#searches.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#searches.delete(oldest);
      this.#dropFromSearch(oldest);
    }
  }

  /** A link a search of this chat returned, kept or not, so a page later read from it is checked too. */
  rememberResultLink({ scope, url }: { scope: FetchedPageScope; url: string }): void {
    const entry = this.#liveSearches(chatKey(scope));
    if (entry === undefined) {
      return;
    }
    const link = pageUrlKey(url);
    entry.result_links.delete(link);
    entry.result_links.add(link);
    while (entry.result_links.size > MAX_RESULT_LINKS_PER_CHAT) {
      const oldest = entry.result_links.values().next().value;
      if (oldest === undefined) {
        break;
      }
      entry.result_links.delete(oldest);
    }
  }

  /**
   * Whether a name, address or result text is mostly words from this chat's searches, compared as a
   * set so order, punctuation and an added word do not hide it. Deny by default: text with no telling
   * words, a chat with no searches left, or a chat whose searches mixed scripts in a word, counts as an echo.
   */
  echoesQueries({ scope, text }: { scope: FetchedPageScope; text: string }): boolean {
    const entry = this.#liveSearches(chatKey(scope));
    const telling = [...significantWords(text)];
    if (entry === undefined || entry.has_mixed_script_word || telling.length === 0) {
      return true;
    }
    const searched = telling.filter(word => entry.words.has(word)).length;
    return searched / telling.length >= QUERY_ECHO_SHARE;
  }

  #liveSearches(key: string): ChatSearches | undefined {
    const entry = this.#searches.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expires_at <= this.#now()) {
      this.#searches.delete(key);
      this.#dropFromSearch(key);
      return undefined;
    }
    return entry;
  }

  #dropFromSearch(chat: string): void {
    for (const [key, stored] of this.#pages) {
      if (stored.from_search && key.startsWith(chat)) {
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
function searchResultPartsOf(record: Record<string, unknown>): string[] {
  const parts = [stringField(record, 'title'), stringField(record, 'snippet'), pageTextOf(record)].filter(
    (part): part is string => part !== undefined,
  );
  return [...new Set(parts)];
}

/**
 * Records each result a search tool returned as a source, keyed by that result's own link. Only the
 * results list counts: the query, a result whose title or text is mostly this chat's search words,
 * and any answer a provider wrote are never recorded. A call whose arguments name a link fetched something, so nothing from it is recorded.
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
      if (url === undefined || url.length > MAX_STORED_URL_CHARS) {
        continue;
      }
      input.pages.rememberResultLink({ scope: input.scope, url });
      const parts = searchResultPartsOf(item);
      if (parts.length === 0 || parts.some(part => input.pages.echoesQueries({ scope: input.scope, text: part }))) {
        continue;
      }
      const resultText = parts.join('\n');
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
