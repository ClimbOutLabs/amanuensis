/** Wording of held web search, page and map cards and their audit rows. Browser-safe: the UI reads it too. */
import { TAVILY_API_HOST, TAVILY_CONNECTOR_HOST } from '../search/TavilyClient.js';
import type { OutboundGuardRule } from './outboundGuard.js';
import type { ReadSource } from './provenance.js';

/** Clause for a held key in other tools' outbound reasons; search cards use SECRET_SAY instead. */
export const SERVER_SECRET_REASON = "it contains one of this computer's keys";

/** Names the connector when the search call carries no server name. */
export const SEARCH_SERVER_FALLBACK = 'the search provider';

const SEARCH_WHAT_PREFIX = 'Search the web through ';
const PAGE_WHAT_PREFIX = 'Open a web page through ';

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

/** The held card names the lookup in plain words, never the connector's id. Kept so saved cards still match. */
const WEB_SEARCH_WHAT_PREFIX = 'Web search: ';
const OPEN_PAGE_WHAT_PREFIX = 'Open a web page: ';

/** Opening of the Tavily search card sentence, under the older wording. Kept so saved cards still match. */
export const TAVILY_SEARCH_WHAT_PREFIX = 'Search the web with Tavily for: ';

/** Opening of a Tavily search card sentence, as a question. */
export const TAVILY_SEARCH_QUESTION_PREFIX = 'Search the web with Tavily for ';

/** Opening of the Tavily page-read card sentence. */
export const TAVILY_EXTRACT_WHAT_PREFIX = 'Open these web pages with Tavily: ';

/** The sentence for a held key. It names no one, so a card saved under older wording can show it too. */
export const SECRET_SAY = 'This sends something that looks like a password or key.';

/** The sentence for a saved hold whose reason was not kept. It names no one, for the same reason. */
export const ASKED_FIRST_SAY = 'It checked with you first.';

/**
 * The one sentence that says why the assistant is asking, in its own name. The card, the activity list and the
 * model's note all show the same sentence. Precise limits never go in it.
 */
export function holdSay(assistant: string) {
  return {
    search_setting: `Searches are set to ask, so ${assistant} is checking with you first.`,
    search_limit: `${assistant} stopped looking things up, because it already looked up a lot in this reply. Ask again to keep going.`,
    steered: `${assistant} found this link in something it read, and opening it would send more than the link said.`,
    private_detail: `This would send a private detail of yours, in a chat where ${assistant} has read things written by other people, so ${assistant} is checking with you first.`,
    secret: SECRET_SAY,
    card_number: 'This sends something that looks like a payment card number.',
    encoded: 'This sends a long block of coded text.',
    long: `This is a long search, so ${assistant} is checking with you first.`,
    unreadable: `This has more text than ${assistant} can check.`,
    generic: `${assistant} is checking with you first.`,
    maps_always: `Maps are set to ask, so ${assistant} is checking with you first.`,
    maps_offline: `${assistant} is offline, so maps can't run.`,
  } as const;
}

/** The place an address or link was read, as a card names it. */
const READ_PLACE: Record<ReadSource, string> = {
  email_sender: 'an email',
  email: 'an email',
  event: 'a calendar event',
  page: 'a page',
  browser_page: 'a page',
  file: 'a file',
  tool_result: 'a tool result',
  other: 'something',
};

/**
 * Says who a send goes to and where the assistant read that address or link, in plain words and without alarm. `who`
 * is already escaped for display: `Name (address)`, an address, or a link.
 */
export function steeredDestinationSay(input: {
  assistant: string;
  destinations: readonly { who: string; kind: 'address' | 'link'; source: ReadSource }[];
}): string {
  const { assistant } = input;
  const sentences = input.destinations.map(({ who, kind, source }) => {
    if (kind === 'link') {
      return `This goes to ${who}, which was in ${READ_PLACE[source]} ${assistant} read.`;
    }
    return source === 'email_sender'
      ? `This goes to ${who}, who sent the email ${assistant} just read.`
      : `This goes to ${who}, whose address was in ${READ_PLACE[source]} ${assistant} read.`;
  });
  return [...new Set(sentences)].join(' ');
}

/** Which sentence each rule the outbound secret guard can trip on says. */
const GUARD_RULE_SAY: Record<OutboundGuardRule, keyof ReturnType<typeof holdSay>> = {
  server_secret: 'secret',
  private_key: 'secret',
  jwt: 'secret',
  key_prefix: 'secret',
  password_label: 'secret',
  encoded_run: 'encoded',
  card_number: 'card_number',
  too_long: 'long',
  uninspectable: 'unreadable',
};

/** The sentence for a rule the outbound secret guard tripped on. */
export function guardRuleSay(input: { rule: OutboundGuardRule; assistant: string }): string {
  return holdSay(input.assistant)[GUARD_RULE_SAY[input.rule]];
}

/**
 * Joins a line to its reason sentence. A line that already ends its sentence gets no extra period.
 */
export function withHoldSay(text: string, say: string): string {
  return `${text}${/[.!?]$/.test(text) ? '' : '.'} ${say}`;
}

/** Card question for a held lookup; the summary is already masked where it must be. A page read says it opens a page. */
export function searchHoldCardText({ summary, say, page }: { summary: string; say: string; page: boolean }): string {
  if (page) {
    return withHoldSay(summary === '' ? 'Open this web page?' : `Open ${summary}?`, say);
  }
  return withHoldSay(summary === '' ? 'Search the web?' : `Search the web for ${summary}?`, say);
}

/** Audit row text for a held lookup: the rule that fired, never the query. */
export function searchHoldAuditText({ server, say, page }: { server: string; say: string; page: boolean }): string {
  return withHoldSay(`${page ? PAGE_WHAT_PREFIX : SEARCH_WHAT_PREFIX}${server}`, say);
}

/** Whether a card sentence describes a held search or page read, generic or Tavily, old or new wording. */
export function isSearchHoldCardText(text: string): boolean {
  if (
    [
      WEB_SEARCH_WHAT_PREFIX,
      OPEN_PAGE_WHAT_PREFIX,
      SEARCH_WHAT_PREFIX,
      PAGE_WHAT_PREFIX,
      TAVILY_SEARCH_WHAT_PREFIX,
      TAVILY_EXTRACT_WHAT_PREFIX,
      TAVILY_SEARCH_QUESTION_PREFIX,
      'Search the web for ',
      'Search the web?',
      'Open this web page?',
    ].some(prefix => text.startsWith(prefix))
  ) {
    return true;
  }
  // A page question names the page itself, so it has no fixed prefix past "Open ".
  return text.startsWith('Open ') && text.includes('?');
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
  return { say: secret ? SECRET_SAY : ASKED_FIRST_SAY, secret };
}
