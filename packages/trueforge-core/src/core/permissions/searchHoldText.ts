/** Wording of held web search and map cards and their audit rows. Browser-safe: the UI reads it too. */
import { TAVILY_API_HOST, TAVILY_CONNECTOR_HOST } from '../search/TavilyClient.js';
import type { OutboundGuardRule } from './outboundGuard.js';

/** Clause for a held key in other tools' outbound reasons; search cards use HOLD_SAY.secret instead. */
export const SERVER_SECRET_REASON = "it contains one of this computer's keys";

/** Names the connector when the search call carries no server name. */
export const SEARCH_SERVER_FALLBACK = 'the search provider';

const SEARCH_WHAT_PREFIX = 'Search the web through ';

/** Brand names of the known search providers, by the host their connector or API answers on. */
const PROVIDER_LABEL_BY_HOST = new Map<string, string>([
  [TAVILY_CONNECTOR_HOST, 'Tavily'],
  [TAVILY_API_HOST, 'Tavily'],
  ['search.parallel.ai', 'Parallel'],
]);

/**
 * The brand a person sees for the web search provider, by the host its connector answers on. Undefined
 * for any other provider: callers then say "the search provider", never the connector's id or host.
 */
export function searchProviderLabel({ host }: { host: string | undefined }): string | undefined {
  return host === undefined ? undefined : PROVIDER_LABEL_BY_HOST.get(host.toLowerCase());
}

/** The held web search card names the search in plain words, never the connector's id. */
const WEB_SEARCH_NAME = 'Web search';
const WEB_SEARCH_WHAT_PREFIX = `${WEB_SEARCH_NAME}: `;

/** Opening of the Tavily search card sentence. */
export const TAVILY_SEARCH_WHAT_PREFIX = 'Search the web with Tavily for: ';

/** Opening of the Tavily page-read card sentence. */
export const TAVILY_EXTRACT_WHAT_PREFIX = 'Read these web pages with Tavily: ';

/**
 * The one sentence that says why Aman is asking. The card, the activity list and the model's note
 * all show the same sentence. Precise limits never go in it.
 */
export const HOLD_SAY = {
  search_setting: 'Searches are set to ask, so Aman is checking with you first.',
  private_read: 'This chat has read your private data, so Aman is checking before searching.',
  private_secret: 'This chat opened a file with passwords or keys, so Aman asks before every search.',
  private_detail: 'This search has details from your private data, so Aman is checking with you first.',
  private_unchecked: "Aman can't check this search for your private details, so it is asking first.",
  search_limit: 'Aman has already searched a lot in this reply.',
  unseen_link: "This opens a link that didn't come from your search results.",
  site_limit: 'Aman has already opened a lot of pages on this site in this reply.',
  secret: 'This search contains something that looks like a password or key.',
  card_number: 'This search contains something that looks like a payment card number.',
  encoded: 'This search contains a long block of coded text.',
  long: 'This is a long search, so Aman is checking with you first.',
  unreadable: 'This search has more text than Aman can check.',
  generic: 'Aman is checking with you before searching.',
  maps_private: 'This chat has private data or text that must not leave, so Aman is checking before using maps.',
  maps_always: 'Maps always ask first, so Aman is checking with you.',
  maps_offline: "Aman is offline, so maps can't run.",
} as const;

/** The sentence for each rule the outbound secret guard can trip on. */
export const GUARD_RULE_SAY: Record<OutboundGuardRule, string> = {
  server_secret: HOLD_SAY.secret,
  private_key: HOLD_SAY.secret,
  jwt: HOLD_SAY.secret,
  key_prefix: HOLD_SAY.secret,
  password_label: HOLD_SAY.secret,
  encoded_run: HOLD_SAY.encoded,
  card_number: HOLD_SAY.card_number,
  too_long: HOLD_SAY.long,
  uninspectable: HOLD_SAY.unreadable,
};

/**
 * Joins a line to its reason sentence. A line that already ends its sentence gets no extra period.
 */
export function withHoldSay(text: string, say: string): string {
  return `${text}${/[.!?]$/.test(text) ? '' : '.'} ${say}`;
}

/** Card sentence for a held search; the summary is already masked where it must be. */
export function searchHoldCardText({ summary, say }: { summary: string; say: string }): string {
  const subject = summary === '' ? WEB_SEARCH_NAME : `${WEB_SEARCH_WHAT_PREFIX}${summary}`;
  return withHoldSay(subject, say);
}

/** Audit row text for a held search: the rule that fired, never the query. */
export function searchHoldAuditText({ server, say }: { server: string; say: string }): string {
  return withHoldSay(`${SEARCH_WHAT_PREFIX}${server}`, say);
}

/** Whether a card sentence describes a held search, generic or Tavily. */
export function isSearchHoldCardText(text: string): boolean {
  return [WEB_SEARCH_WHAT_PREFIX, SEARCH_WHAT_PREFIX, TAVILY_SEARCH_WHAT_PREFIX, TAVILY_EXTRACT_WHAT_PREFIX].some(
    prefix => text.startsWith(prefix),
  );
}

// Cards saved before the hold reason moved into plain_what kept it in why_asked_again, in older wording.
const SAVED_HOLD_PREFIX = 'Held for approval: ';
const SAVED_SECRET_REASONS = ['it contains a secret this server holds', SERVER_SECRET_REASON];

export interface SavedSearchHold {
  /** The sentence the saved card now shows. */
  say: string;
  /** True when the saved hold was for a key, so the query is not recoverable. */
  secret: boolean;
}

/** A search hold saved under the older wording, or undefined when the card has none to read back. */
export function savedSearchHold(whyAskedAgain: string | null): SavedSearchHold | undefined {
  if (!whyAskedAgain?.startsWith(SAVED_HOLD_PREFIX)) {
    return undefined;
  }
  const reason = whyAskedAgain.slice(SAVED_HOLD_PREFIX.length).replace(/\.$/, '');
  const secret = SAVED_SECRET_REASONS.includes(reason);
  return { say: secret ? HOLD_SAY.secret : HOLD_SAY.generic, secret };
}
