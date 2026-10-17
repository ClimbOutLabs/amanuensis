/** Wording of held web search cards and their audit rows. Browser-safe: the UI reads it too. */

/** Why a search holding one of this computer's keys is held. */
export const SERVER_SECRET_REASON = "it contains one of this computer's keys";

/** Why a search is held when the owner set searches to ask. */
export const SEARCH_ASK_REASON = 'searches are set to ask';

/** Names the connector when the search call carries no server name. */
export const SEARCH_SERVER_FALLBACK = 'the search provider';

/** Why a search was held when the stored hold does not say. */
export const SEARCH_HELD_REASON = 'it needed approval';

const SEARCH_WHAT_PREFIX = 'Search the web through ';

/** Opening of the Tavily search card sentence, which also names what the call costs. */
export const TAVILY_SEARCH_WHAT_PREFIX = 'Search the web with Tavily for: ';

/** Opening of the Tavily page-read card sentence. */
export const TAVILY_EXTRACT_WHAT_PREFIX = 'Read these web pages with Tavily: ';

// Cards saved before the hold reason moved into plain_what kept it here, with older key wording.
const SAVED_HOLD_PREFIX = 'Held for approval: ';
const SAVED_SECRET_REASON = 'it contains a secret this server holds';

/** The ". Held because ..." tail of a card sentence, or '' when the hold has no reason to give. */
export function heldBecause(why: string): string {
  return why === '' ? '' : `. Held because ${why}.`;
}

/** Card sentence for a held search; the query is already masked where it must be. */
export function searchHoldCardText({ server, query, why }: { server: string; query: string; why: string }): string {
  return `${SEARCH_WHAT_PREFIX}${server} for: ${query}${heldBecause(why)}`;
}

/** Audit row text for a held search: the rule that fired, never the query. */
export function searchHoldAuditText({ server, why }: { server: string; why: string }): string {
  return `${SEARCH_WHAT_PREFIX}${server}${heldBecause(why === '' ? SEARCH_ASK_REASON : why)}`;
}

/** Whether a card sentence describes a held search, generic or Tavily. */
export function isSearchHoldCardText(text: string): boolean {
  return [SEARCH_WHAT_PREFIX, TAVILY_SEARCH_WHAT_PREFIX, TAVILY_EXTRACT_WHAT_PREFIX].some(prefix =>
    text.startsWith(prefix),
  );
}

/** Hold reason a search card saved before this wording kept in why_asked_again, or undefined. */
export function savedSearchHoldReason(whyAskedAgain: string | null): string | undefined {
  if (!whyAskedAgain?.startsWith(SAVED_HOLD_PREFIX)) {
    return undefined;
  }
  const reason = whyAskedAgain.slice(SAVED_HOLD_PREFIX.length).replace(/\.$/, '');
  return reason === SAVED_SECRET_REASON ? SERVER_SECRET_REASON : reason;
}
