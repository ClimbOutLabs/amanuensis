/**
 * Host state and helpers for the designated search provider's silent runs: the per-turn count that
 * trips the loop breaker and the set of URLs the provider's own results returned, which is all a
 * silent fetch may name. Both live in host memory for one turn and never reach the model.
 */

/** Silent searches one turn may run before the next one asks. */
export const SILENT_SEARCH_LIMIT = 20;

/** Silent fetches of one host a turn may run before the next one asks. */
export const SILENT_FETCHES_PER_HOST = 2;

/** Cap on remembered result URLs per turn, so a huge result cannot grow host memory without bound. */
const MAX_RESULT_URLS = 500;

/** Reason code for a search the designated provider ran without asking. */
export const SEARCH_SILENT_REASON = 'mcp_search_provider';

/** Reason code for a search that ran without asking after a mail or calendar read, because its text was checked. */
export const SEARCH_AFTER_READ_SILENT_REASON = 'mcp_search_after_read_checked';

/** Whether a decision reason is a search that ran without asking, after a private read or not. */
export function isSilentSearchReason(reason: string): boolean {
  return reason === SEARCH_SILENT_REASON || reason === SEARCH_AFTER_READ_SILENT_REASON;
}

/** Reason codes for a designated-provider call that stops for approval, and why. */
export const SEARCH_ASK_REASONS = [
  'mcp_search_setting_ask',
  'mcp_search_guard',
  'mcp_search_limit',
  'mcp_search_unreturned_url',
  'mcp_search_host_limit',
  'mcp_search_after_private_read',
] as const;
export type SearchAskReason = (typeof SEARCH_ASK_REASONS)[number];

export function isSearchAskReason(reason: string): boolean {
  return SEARCH_ASK_REASONS.some(known => known === reason);
}

/** What the host lets the designated search provider's connector do silently, resolved for one turn. */
export interface SearchProviderGrant {
  /** Tools that run without asking even when the server does not declare them read-only. */
  tools: readonly string[];
  /** Top-level argument names that are provider plumbing, not user text. */
  plumbing_fields: readonly string[];
}

export interface WebSearchTurnState {
  /** Searches that ran without asking this turn. */
  silentSearches: number;
  /** URLs the designated provider returned this turn, exactly as returned. */
  resultUrls: Set<string>;
  /** Silent fetches this turn, by host. */
  fetchesByHost: Map<string, number>;
  /** Tail of the text those searches sent, so a secret split across two searches is seen whole. */
  sentText: string;
  /** True once the session read private data (mail, calendar or a secret), after which a search is checked or asks. */
  privateDataRead: boolean;
  /** Text of the mail and calendar results this turn received, so a later search can be checked against it. */
  privateTexts: string[];
  /** Mail and calendar reads marked this turn, by any thread. Each one must have its result kept as text. */
  privateReadMarks: number;
  /** Mail and calendar results kept as text this turn, by any thread. */
  privateTextsKept: number;
  /** True when the private mark came from saved state or old context, whose text this turn never saw. */
  privateTextLost: boolean;
  /** Tail of the one-at-a-time chain that classifies and counts the turn's search calls. */
  admission: Promise<void>;
}

export function createWebSearchTurnState(): WebSearchTurnState {
  return {
    silentSearches: 0,
    resultUrls: new Set(),
    fetchesByHost: new Map(),
    sentText: '',
    privateDataRead: false,
    privateTexts: [],
    privateReadMarks: 0,
    privateTextsKept: 0,
    privateTextLost: false,
    admission: Promise.resolve(),
  };
}

/**
 * Runs the work after every earlier call of this turn finished its own, whether it succeeded or not.
 * The silent count and the text already sent are then read and updated by one call at a time, so
 * the parallel calls of one batch cannot all pass on the same count or split a secret between them.
 */
export function runOneAtATime<T>(input: { state: WebSearchTurnState; work: () => Promise<T> }): Promise<T> {
  const run = input.state.admission.then(input.work);
  input.state.admission = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const SCHEME_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\`]+/g;
const SCHEMELESS_URL_WITH_PATH = /(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/[^\s"'<>\\`]*/g;
const WWW_URL = /(?<![\w@.-])www\.[^\s"'<>\\`]+/gi;
/** A whole value that is a bare host (optionally with port and path): `example.com`, `10.0.0.1:8080/x`. */
const WHOLE_HOST = /^(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/;

/** URLs in free text, each match removed before the next pattern runs so one URL is never counted twice. */
function urlsInText(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const pattern of [SCHEME_URL, WWW_URL, SCHEMELESS_URL_WITH_PATH]) {
    rest = rest.replace(pattern, match => {
      found.push(match);
      return ' ';
    });
  }
  return found;
}

/** Keys whose contents describe the page or what it links to, never the result itself. */
const NON_RESULT_KEYS = new Set(['links', 'metadata', 'images', 'favicon', 'excerpts', 'content', 'raw_content']);
const MAX_RESULT_DEPTH = 3;

/** The `url` field of each result object in a provider's JSON; text inside a result is never read for links. */
function collectResultUrls(node: unknown, into: string[], depth: number): void {
  if (depth > MAX_RESULT_DEPTH) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectResultUrls(child, into, depth + 1);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (key === 'url' && typeof child === 'string') {
        into.push(child);
      } else if (!NON_RESULT_KEYS.has(key)) {
        collectResultUrls(child, into, depth + 1);
      }
    }
  }
}

/**
 * Remembers each result's own `url` field, as returned. A link that only appears in an excerpt, a
 * result's own links, or prose is not a result, so a fetch of it asks. Nothing else is ever added.
 */
export function recordResultUrls(input: { state: WebSearchTurnState; texts: readonly string[] }): void {
  for (const text of input.texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const urls: string[] = [];
    collectResultUrls(parsed, urls, 0);
    for (const url of urls) {
      if (url.length > 0 && input.state.resultUrls.size < MAX_RESULT_URLS) {
        input.state.resultUrls.add(url);
      }
    }
  }
}

function isWholeUrl(value: string): boolean {
  return WHOLE_HOST.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value) || /^www\.\S+$/i.test(value);
}

/** Whether any outbound value is, or contains, a URL: a call that fetches rather than searches. */
export function namesUrl(values: readonly string[]): boolean {
  return values.some(value => isWholeUrl(value) || urlsInText(value).length > 0);
}

/**
 * URLs an outbound call names that no search result of this turn returned. A value that is itself a
 * URL must match a returned one exactly; a URL embedded in prose may also match without trailing
 * punctuation. A bare hostname counts as a URL, so a model cannot compose a fetch by dropping the
 * scheme.
 */
export function unreturnedUrls(input: { values: readonly string[]; state: WebSearchTurnState }): string[] {
  const unreturned: string[] = [];
  for (const value of input.values) {
    if (isWholeUrl(value)) {
      if (!input.state.resultUrls.has(value)) {
        unreturned.push(value);
      }
      continue;
    }
    for (const url of urlsInText(value)) {
      if (!input.state.resultUrls.has(url) && !input.state.resultUrls.has(url.replace(TRAILING_PUNCTUATION, ''))) {
        unreturned.push(url);
      }
    }
  }
  return unreturned;
}

/** Host of a URL as the fetch would reach it, or undefined when the value does not parse as one. */
function hostOfUrl(value: string): string | undefined {
  try {
    return new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Distinct hosts of the URLs an outbound call names. */
function fetchedHosts(values: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const value of values) {
    for (const url of isWholeUrl(value) ? [value] : urlsInText(value)) {
      const host = hostOfUrl(url);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return hosts;
}

/** Whether the call names a host the turn already fetched silently its allowance of times. */
export function namesHostAtFetchLimit(input: { values: readonly string[]; state: WebSearchTurnState }): boolean {
  return [...fetchedHosts(input.values)].some(
    host => (input.state.fetchesByHost.get(host) ?? 0) >= SILENT_FETCHES_PER_HOST,
  );
}

export function countSilentFetches(input: { values: readonly string[]; state: WebSearchTurnState }): void {
  for (const host of fetchedHosts(input.values)) {
    input.state.fetchesByHost.set(host, (input.state.fetchesByHost.get(host) ?? 0) + 1);
  }
}

/**
 * The one place that records and answers "has this session read private data". A tool that returns the user's
 * private content (mail, and later maps or calendar) marks it; the search provider's classifier reads it.
 */
export function markPrivateDataRead(state: WebSearchTurnState): void {
  state.privateDataRead = true;
  state.privateReadMarks += 1;
}

/** Mark restored from saved state or from the context of a thread: the text it read is not held here. */
export function markPrivateDataReadFromHistory(state: WebSearchTurnState): void {
  state.privateDataRead = true;
  state.privateTextLost = true;
}

export function hasReadPrivateData(state: WebSearchTurnState): boolean {
  return state.privateDataRead;
}

/** Above this, the text is not kept whole, so a check could miss a copy; the turn then asks. */
const MAX_PRIVATE_TEXT_CHARS = 2_000_000;

/** Keeps the text a mail or calendar result returned, for the checks on later searches and maps. */
export function recordPrivateReadText(input: { state: WebSearchTurnState; text: string }): void {
  const { state, text } = input;
  state.privateTextsKept += 1;
  if (state.privateTextLost) {
    return;
  }
  const kept = state.privateTexts.reduce((total, held) => total + held.length, 0);
  if (kept + text.length > MAX_PRIVATE_TEXT_CHARS) {
    state.privateTexts = [];
    state.privateTextLost = true;
    return;
  }
  state.privateTexts.push(text);
}

/**
 * The text a search or map is checked against, or undefined when it is not all there: the mark came
 * from earlier history, or some mail or calendar read this turn has no result kept to compare with.
 */
export function privateTextForChecks(state: WebSearchTurnState): readonly string[] | undefined {
  if (state.privateTextLost || state.privateTextsKept < state.privateReadMarks) {
    return undefined;
  }
  return state.privateTexts;
}

/**
 * Whether a remote image a reply links may load without asking, by the same rules as a silent fetch
 * through the designated search provider: searches run without asking, the outbound guard passes, the
 * chat has not read private data, the turn has not used its silent allowance, and the link is exactly
 * one this turn's searches returned. Returns the reason it asks, or null when it may load silently.
 */
export function remoteImageAskReason(input: {
  url: string;
  searchWithoutAsking: boolean;
  guardPassed: boolean;
  privateDataRead: boolean;
  silentShown: number;
  state: WebSearchTurnState;
}): SearchAskReason | null {
  if (!input.searchWithoutAsking) {
    return 'mcp_search_setting_ask';
  }
  if (!input.guardPassed) {
    return 'mcp_search_guard';
  }
  if (input.privateDataRead) {
    return 'mcp_search_after_private_read';
  }
  if (input.silentShown >= SILENT_SEARCH_LIMIT) {
    return 'mcp_search_limit';
  }
  if (unreturnedUrls({ values: [input.url], state: input.state }).length > 0) {
    return 'mcp_search_unreturned_url';
  }
  return null;
}
