/**
 * The one matching rule for past-chat search. Every store indexes and queries the same words,
 * built here, so a search finds the same chats whichever store serves it: text is put in
 * NFKC form, split into lowercase letter-and-digit words (combining marks stay inside the
 * word they belong to, so scripts that build letters from marks are not broken apart),
 * common English filler words are dropped, and plural, -ing / -ed and silent -e endings are
 * taken off. A message matches when it holds every query word as a whole word, so "trip"
 * matches "trips" and "tripped" but never "tripod".
 */

/** NFKC first so a letter written as a base plus a combining mark becomes the single letter. */
function normalizeChatSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFKC');
}

export const CHAT_SEARCH_SNIPPET_MAX_CHARS = 300;

/** Filler words a search ignores, in the query and in the index. */
const CHAT_SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const ASCII_WORD = /^[a-z]+$/;
/** A doubled final consonant left behind by -ing / -ed ("planned" -> "plann"), except ll, ss and zz. */
const DOUBLED_CONSONANT = /([b-df-hj-km-np-rtv-xz])\1$/;

function undouble(word: string): string {
  return DOUBLED_CONSONANT.test(word) && !/(ll|ss|zz)$/.test(word) ? word.slice(0, -1) : word;
}

/** Takes plural and -ing / -ed endings off an English word; other words are kept as they are. */
function chatSearchStem(word: string): string {
  if (word.length <= 3 || !ASCII_WORD.test(word)) {
    return word;
  }
  let stem = word;
  if (stem.endsWith('ies') && stem.length > 4) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.endsWith('sses')) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('s') && !/(ss|us|is)$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  if (stem.endsWith('ing') && stem.length - 3 >= 3) {
    stem = undouble(stem.slice(0, -3));
  } else if (stem.endsWith('ed') && stem.length - 2 >= 3) {
    stem = undouble(stem.slice(0, -2));
  }
  // A silent final e goes too, so "decide", "decided" and "decides" meet at "decid".
  return stem.endsWith('e') && stem.length > 3 ? stem.slice(0, -1) : stem;
}

/** The searchable words of a text, in order, filler words left out. */
export function chatSearchWords(text: string): string[] {
  return normalizeChatSearchText(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(word => word.length > 0 && !CHAT_SEARCH_STOPWORDS.has(word))
    .map(chatSearchStem);
}

/** The words a query is matched by, duplicates removed. A query of filler words alone has none. */
export function chatSearchQueryTerms(query: string): string[] {
  return [...new Set(chatSearchWords(query))];
}

/** The distinct searchable words of one message, the form every store keeps in its index. */
export function chatSearchIndexWords(text: string): string[] {
  return [...new Set(chatSearchWords(text))];
}

/** Where the first word of `text` that matches one of `terms` starts, or -1. */
function firstMatchOffset(text: string, terms: readonly string[]): number {
  const wanted = new Set(terms);
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const word = normalizeChatSearchText(match[0]);
    if (!CHAT_SEARCH_STOPWORDS.has(word) && wanted.has(chatSearchStem(word))) {
      return match.index;
    }
  }
  return -1;
}

/**
 * The excerpt a hit shows: at most {@link CHAT_SEARCH_SNIPPET_MAX_CHARS} characters of the
 * matched message, flattened to one line, opened near the first matching word when the
 * message is longer.
 */
export function buildChatSearchSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= CHAT_SEARCH_SNIPPET_MAX_CHARS) {
    return flat;
  }
  const firstMatch = firstMatchOffset(flat, chatSearchQueryTerms(query));
  if (firstMatch < 0) {
    return flat.slice(0, CHAT_SEARCH_SNIPPET_MAX_CHARS);
  }
  const start = Math.max(
    0,
    Math.min(firstMatch - Math.floor(CHAT_SEARCH_SNIPPET_MAX_CHARS / 3), flat.length - CHAT_SEARCH_SNIPPET_MAX_CHARS),
  );
  return flat.slice(start, start + CHAT_SEARCH_SNIPPET_MAX_CHARS);
}
