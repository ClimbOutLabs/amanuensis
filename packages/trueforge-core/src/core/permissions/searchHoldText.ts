/** Wording of held web search cards and their audit rows. Browser-safe: the UI reads it too. */

/** Why a search holding one of this computer's keys is held. */
export const SERVER_SECRET_REASON = "it contains one of this computer's keys";

/** Why a search is held when the owner set searches to ask. */
export const SEARCH_ASK_REASON = 'searches are set to ask';

const SEARCH_WHAT_PREFIX = 'Search the web through ';

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

/** Whether a card sentence was written by `searchHoldCardText`. */
export function isSearchHoldCardText(text: string): boolean {
  return text.startsWith(SEARCH_WHAT_PREFIX);
}
