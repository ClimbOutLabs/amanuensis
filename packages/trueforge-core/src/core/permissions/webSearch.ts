/**
 * Host state and helpers for the designated search provider's silent runs: the per-turn count that
 * trips the loop breaker, the set of URLs the provider's own results returned, which is all a
 * silent fetch may name, and the encoded-looking values it returned, which are the only plumbing
 * values (its own session id) the guard lets through as such. All live in host memory for one turn
 * and never reach the model.
 */

import { encodedRunsIn } from './outboundGuard';

/** Silent searches one turn may run before the next one asks. */
export const SILENT_SEARCH_LIMIT = 20;

/** Cap on remembered result URLs per turn, so a huge result cannot grow host memory without bound. */
const MAX_RESULT_URLS = 500;

/** Cap on remembered result tokens per turn, for the same reason. */
const MAX_RESULT_TOKENS = 200;

/** Reason code for a search the designated provider ran without asking. */
export const SEARCH_SILENT_REASON = 'mcp_search_provider';

/** Reason codes for a designated-provider call that stops for approval, and why. */
export const SEARCH_ASK_REASONS = [
  'mcp_search_setting_ask',
  'mcp_search_guard',
  'mcp_search_limit',
  'mcp_search_unreturned_url',
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
  /** Encoded-looking values the designated provider returned this turn, exactly as returned. */
  resultTokens: Set<string>;
  /** Tail of the text those searches sent, so a secret split across two searches is seen whole. */
  sentText: string;
  /** Tail of the one-at-a-time chain that classifies and counts the turn's search calls. */
  admission: Promise<void>;
}

export function createWebSearchTurnState(): WebSearchTurnState {
  return {
    silentSearches: 0,
    resultUrls: new Set(),
    resultTokens: new Set(),
    sentText: '',
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

function collectJsonStrings(node: unknown, into: string[], depth: number): void {
  if (depth > 8) {
    return;
  }
  if (typeof node === 'string') {
    into.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) {
      collectJsonStrings(child, into, depth + 1);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const child of Object.values(node)) {
      collectJsonStrings(child, into, depth + 1);
    }
  }
}

/** Text blocks often carry a JSON document; parse it so escaped slashes and string values read as URLs. */
function textCandidates(text: string): string[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const strings: string[] = [];
      collectJsonStrings(JSON.parse(text), strings, 0);
      return [text, ...strings];
    } catch {
      return [text];
    }
  }
  return [text];
}

/**
 * Remembers every URL in a search provider result. Both the URL as found and the same URL without
 * trailing sentence punctuation count as returned; nothing else is ever added.
 */
export function recordResultUrls(input: { state: WebSearchTurnState; texts: readonly string[] }): void {
  for (const text of input.texts) {
    for (const candidate of textCandidates(text)) {
      for (const url of urlsInText(candidate)) {
        for (const variant of [url, url.replace(TRAILING_PUNCTUATION, '')]) {
          if (variant.length > 0 && input.state.resultUrls.size < MAX_RESULT_URLS) {
            input.state.resultUrls.add(variant);
          }
        }
      }
    }
  }
}

/** Remembers every value in a search provider result that the guard would read as an encoded run. */
export function recordResultTokens(input: { state: WebSearchTurnState; texts: readonly string[] }): void {
  for (const text of input.texts) {
    for (const candidate of textCandidates(text)) {
      for (const token of encodedRunsIn(candidate)) {
        if (input.state.resultTokens.size < MAX_RESULT_TOKENS) {
          input.state.resultTokens.add(token);
        }
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
