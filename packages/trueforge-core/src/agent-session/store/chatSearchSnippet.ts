/**
 * Shared excerpt rule for past-chat search hits: at most {@link CHAT_SEARCH_SNIPPET_MAX_CHARS}
 * characters of the matched message, flattened to one line, opened near the first query word
 * when the message is longer. Every backend builds its snippet through this one helper, so a
 * hit reads the same whichever store served it.
 */

export const CHAT_SEARCH_SNIPPET_MAX_CHARS = 300;

/** The words a query is matched by: lowercase letter/digit runs, duplicates removed. */
export function chatSearchQueryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length > 0);
  return [...new Set(terms)];
}

export function buildChatSearchSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= CHAT_SEARCH_SNIPPET_MAX_CHARS) {
    return flat;
  }
  const lower = flat.toLowerCase();
  let firstMatch = -1;
  for (const term of chatSearchQueryTerms(query)) {
    const at = lower.indexOf(term);
    if (at >= 0 && (firstMatch < 0 || at < firstMatch)) {
      firstMatch = at;
    }
  }
  if (firstMatch < 0) {
    return flat.slice(0, CHAT_SEARCH_SNIPPET_MAX_CHARS);
  }
  const start = Math.max(
    0,
    Math.min(firstMatch - Math.floor(CHAT_SEARCH_SNIPPET_MAX_CHARS / 3), flat.length - CHAT_SEARCH_SNIPPET_MAX_CHARS),
  );
  return flat.slice(start, start + CHAT_SEARCH_SNIPPET_MAX_CHARS);
}
