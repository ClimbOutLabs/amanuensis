/** Wording of held web search and map cards and their audit rows. Browser-safe: the UI reads it too. */
import { TAVILY_API_HOST, TAVILY_CONNECTOR_HOST } from '../search/TavilyClient.js';
import type { OutboundGuardRule } from './outboundGuard.js';

/** Clause for a held key in other tools' outbound reasons; search cards use the held key's own sentence instead. */
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
/** A held call that reads a page names it as opening a page, not as a search. */
const WEB_PAGE_NAME = 'Open a web page';
const WEB_PAGE_WHAT_PREFIX = `${WEB_PAGE_NAME}: `;

/** Opening of the Tavily search card sentence. */
export const TAVILY_SEARCH_WHAT_PREFIX = 'Search the web with Tavily for: ';

/** Opening of the Tavily page-read card sentence. */
export const TAVILY_EXTRACT_WHAT_PREFIX = 'Read these web pages with Tavily: ';

/** The sentence for a held key. It names no one, so a card saved under older wording can be read back with it. */
const SECRET_SAY = 'This search contains something that looks like a password or key.';

/** The sentence for a held search whose reason was not saved. It names no one, for the same reason. */
export const GENERIC_HOLD_SAY = 'This search waits for your OK before it runs.';

/**
 * The one sentence that says why the assistant is asking, by the name the person gave it. The card, the activity list
 * and the model's note all show the same sentence. Precise limits never go in it.
 */
export function holdSay(assistant: string) {
  return {
    search_setting: `Searches are set to ask, so ${assistant} is checking with you first.`,
    private_read: `This chat has read your private data, so ${assistant} is checking before searching.`,
    private_secret: `This chat opened a file with passwords or keys, so ${assistant} asks before every search.`,
    private_detail: `This search has details from your private data, so ${assistant} is checking with you first.`,
    private_unchecked: `${assistant} can't check this search for your private details, so it is asking first.`,
    search_limit: `${assistant} has already searched a lot in this reply.`,
    unseen_link: "This opens a link that didn't come from your search results.",
    site_limit: `${assistant} has already opened a lot of pages on this site in this reply.`,
    secret: SECRET_SAY,
    card_number: 'This search contains something that looks like a payment card number.',
    encoded: 'This search contains a long block of coded text.',
    long: `This is a long search, so ${assistant} is checking with you first.`,
    unreadable: `This search has more text than ${assistant} can check.`,
    maps_private: `This chat has private data or text that must not leave, so ${assistant} is checking before using maps.`,
    maps_always: `Maps always ask first, so ${assistant} is checking with you.`,
    maps_offline: `${assistant} is offline, so maps can't run.`,
  } as const;
}
export type HoldSay = ReturnType<typeof holdSay>;

/** The sentence for each rule the outbound secret guard can trip on. */
export function guardRuleSay({ rule, say }: { rule: OutboundGuardRule; say: HoldSay }): string {
  switch (rule) {
    case 'server_secret':
    case 'private_key':
    case 'jwt':
    case 'key_prefix':
    case 'password_label':
      return say.secret;
    case 'encoded_run':
      return say.encoded;
    case 'card_number':
      return say.card_number;
    case 'too_long':
      return say.long;
    case 'uninspectable':
      return say.unreadable;
  }
}

/**
 * Joins a line to its reason sentence. A line that already ends its sentence gets no extra period.
 */
export function withHoldSay(text: string, say: string): string {
  return `${text}${/[.!?]$/.test(text) ? '' : '.'} ${say}`;
}

/** Card sentence for a held search; the summary is already masked where it must be. */
export function searchHoldCardText({
  summary,
  say,
  opens_page,
}: {
  summary: string;
  say: string;
  /** True when the call reads a page by its link rather than searching. */
  opens_page: boolean;
}): string {
  const name = opens_page ? WEB_PAGE_NAME : WEB_SEARCH_NAME;
  const prefix = opens_page ? WEB_PAGE_WHAT_PREFIX : WEB_SEARCH_WHAT_PREFIX;
  const subject = summary === '' ? name : `${prefix}${summary}`;
  return withHoldSay(subject, say);
}

/** Audit row text for a held search: the rule that fired, never the query. */
export function searchHoldAuditText({ server, say }: { server: string; say: string }): string {
  return withHoldSay(`${SEARCH_WHAT_PREFIX}${server}`, say);
}

/** Whether a card sentence describes a held search, generic or Tavily. */
export function isSearchHoldCardText(text: string): boolean {
  return [
    WEB_SEARCH_WHAT_PREFIX,
    WEB_PAGE_WHAT_PREFIX,
    SEARCH_WHAT_PREFIX,
    TAVILY_SEARCH_WHAT_PREFIX,
    TAVILY_EXTRACT_WHAT_PREFIX,
  ].some(prefix => text.startsWith(prefix));
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
  return { say: secret ? SECRET_SAY : GENERIC_HOLD_SAY, secret };
}
