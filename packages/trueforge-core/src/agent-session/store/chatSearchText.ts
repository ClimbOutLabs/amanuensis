/**
 * The one matching rule for past-chat search. Every store indexes and queries the same words,
 * built here, so a search finds the same chats whichever store serves it: text is put in
 * NFKC form, split into lowercase letter-and-digit words (combining marks stay inside the
 * word they belong to, so scripts that build letters from marks are not broken apart),
 * common English filler words are dropped, and English words are reduced to their Porter
 * stem. A message matches when it holds every query word as a whole word, so "trip"
 * matches "trips" and "tripped" but never "tripod".
 */

/**
 * NFKC first so a letter written as a base plus a combining mark becomes the single letter.
 * Lowercasing "İ" leaves an "i" with a combining dot above, which no letter absorbs, so that
 * dot is dropped and "İstanbul" reads as "istanbul".
 */
function normalizeChatSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/i\u0307/g, 'i');
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

/** Porter's consonant: any letter but a, e, i, o, u, and y when it follows a consonant. */
function isConsonant({ word, at }: { word: string; at: number }): boolean {
  const letter = word[at];
  if (letter === 'a' || letter === 'e' || letter === 'i' || letter === 'o' || letter === 'u') {
    return false;
  }
  return letter === 'y' ? at === 0 || !isConsonant({ word, at: at - 1 }) : true;
}

/** Porter's measure: how many vowel-then-consonant runs the word has. */
function measure(word: string): number {
  let runs = 0;
  let previousVowel = false;
  for (let at = 0; at < word.length; at += 1) {
    const consonant = isConsonant({ word, at });
    if (consonant && previousVowel) {
      runs += 1;
    }
    previousVowel = !consonant;
  }
  return runs;
}

function hasVowel(word: string): boolean {
  for (let at = 0; at < word.length; at += 1) {
    if (!isConsonant({ word, at })) {
      return true;
    }
  }
  return false;
}

function endsWithDoubleConsonant(word: string): boolean {
  const last = word.length - 1;
  return last >= 1 && word[last] === word[last - 1] && isConsonant({ word, at: last });
}

/** Consonant, vowel, consonant at the end, the last not w, x or y: the shape of "hop" or "mad". */
function endsConsonantVowelConsonant(word: string): boolean {
  const last = word.length - 1;
  return (
    last >= 2 &&
    isConsonant({ word, at: last - 2 }) &&
    !isConsonant({ word, at: last - 1 }) &&
    isConsonant({ word, at: last }) &&
    !/[wxy]$/.test(word)
  );
}

/** Replaces the longest listed ending that the word has, when what is left passes the check. */
function replaceEnding({
  word,
  endings,
  keep,
}: {
  word: string;
  endings: readonly (readonly [string, string])[];
  keep: (stem: string) => boolean;
}): string {
  for (const [ending, replacement] of endings) {
    if (word.endsWith(ending)) {
      const stem = word.slice(0, -ending.length);
      return keep(stem) ? stem + replacement : word;
    }
  }
  return word;
}

// Each list runs longest ending first, because only the longest ending a word has is tried.
const STEP_2_ENDINGS = [
  ['ational', 'ate'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['ization', 'ize'],
  ['tional', 'tion'],
  ['biliti', 'ble'],
  ['entli', 'ent'],
  ['ousli', 'ous'],
  ['ation', 'ate'],
  ['alism', 'al'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['abli', 'able'],
  ['alli', 'al'],
  ['ator', 'ate'],
  ['eli', 'e'],
] as const;

const STEP_3_ENDINGS = [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ness', ''],
  ['ful', ''],
] as const;

const STEP_4_ENDINGS = [
  'ement',
  'ance',
  'ence',
  'able',
  'ible',
  'ment',
  'ant',
  'ent',
  'ion',
  'ism',
  'ate',
  'iti',
  'ous',
  'ive',
  'ize',
  'al',
  'er',
  'ic',
  'ou',
] as const;

function porterStep1(word: string): string {
  let stem = word;
  if (stem.endsWith('sses') || stem.endsWith('ies')) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith('s') && !stem.endsWith('ss')) {
    stem = stem.slice(0, -1);
  }
  if (stem.endsWith('eed')) {
    if (measure(stem.slice(0, -3)) > 0) {
      stem = stem.slice(0, -1);
    }
  } else {
    const ending = stem.endsWith('ed') ? 2 : stem.endsWith('ing') ? 3 : 0;
    if (ending > 0 && hasVowel(stem.slice(0, -ending))) {
      stem = stem.slice(0, -ending);
      if (/(at|bl|iz)$/.test(stem)) {
        stem += 'e';
      } else if (endsWithDoubleConsonant(stem) && !/[lsz]$/.test(stem)) {
        stem = stem.slice(0, -1);
      } else if (measure(stem) === 1 && endsConsonantVowelConsonant(stem)) {
        stem += 'e';
      }
    }
  }
  if (stem.endsWith('y') && hasVowel(stem.slice(0, -1))) {
    stem = `${stem.slice(0, -1)}i`;
  }
  return stem;
}

function porterStep4(word: string): string {
  for (const ending of STEP_4_ENDINGS) {
    if (word.endsWith(ending)) {
      const stem = word.slice(0, -ending.length);
      const allowed = measure(stem) > 1 && (ending !== 'ion' || /[st]$/.test(stem));
      return allowed ? stem : word;
    }
  }
  return word;
}

function porterStep5(word: string): string {
  let stem = word;
  if (stem.endsWith('e')) {
    const base = stem.slice(0, -1);
    const baseMeasure = measure(base);
    if (baseMeasure > 1 || (baseMeasure === 1 && !endsConsonantVowelConsonant(base))) {
      stem = base;
    }
  }
  if (measure(stem) > 1 && stem.endsWith('ll')) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/**
 * The Porter stemmer for English words, so "trip", "trips" and "tripped" meet at one stem while
 * words such as "made" and "mad" or "string" and "str" stay apart. Other words are kept as they are.
 */
function chatSearchStem(word: string): string {
  if (word.length <= 2 || !ASCII_WORD.test(word)) {
    return word;
  }
  const keepWhenMeasured = (stem: string) => measure(stem) > 0;
  const step3 = replaceEnding({
    word: replaceEnding({ word: porterStep1(word), endings: STEP_2_ENDINGS, keep: keepWhenMeasured }),
    endings: STEP_3_ENDINGS,
    keep: keepWhenMeasured,
  });
  return porterStep5(porterStep4(step3));
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
