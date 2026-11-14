/**
 * Matching a recalled fact against the facts a person pulled out of one chat's recall. The
 * exclusions themselves are stored with the chat (see db/recallExclusionStore); this module
 * only decides whether a recalled item is one of them. Pulling a fact out lasts for the rest
 * of that chat: the recall path skips the fact there, other chats still recall it, and the
 * memory itself is never changed or deleted.
 */

/**
 * The mark a fact's text carries when it was cut short to fit a token budget: the same three
 * dots the memory block's own fitting ends a shortened line with.
 */
const SHORTENED_MARK = '...';
/** A shortened stem shorter than this is too little of the fact to trust as the same fact. */
const SHORTEST_TRUSTED_STEM = 16;

/**
 * Whether a recalled item is one of the facts pulled out of this chat. The pull is recorded
 * in the words the rail showed, and a fact can be shown shortened when a token budget cut it,
 * while the next recall may serve the full text (or the other way round). So beside the exact
 * match, a side carrying the shortening mark matches when its stem is a real opening of the
 * other side's full text: the surface the person acted on and the text the filter sees meet.
 */
export function recallFactExcluded(input: { exclusions: ReadonlySet<string>; shownText: string }): boolean {
  const shown = input.shownText.trim();
  for (const excluded of input.exclusions) {
    const pulled = excluded.trim();
    if (pulled === shown) {
      return true;
    }
    if (pulled.endsWith(SHORTENED_MARK)) {
      const stem = pulled.slice(0, -SHORTENED_MARK.length).trimEnd();
      if (stem.length >= SHORTEST_TRUSTED_STEM && shown.startsWith(stem)) {
        return true;
      }
    }
    if (shown.endsWith(SHORTENED_MARK)) {
      const stem = shown.slice(0, -SHORTENED_MARK.length).trimEnd();
      if (stem.length >= SHORTEST_TRUSTED_STEM && pulled.startsWith(stem)) {
        return true;
      }
    }
  }
  return false;
}
