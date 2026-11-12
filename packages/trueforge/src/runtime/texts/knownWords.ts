import webEndingsData from './webEndings.json';
import wordListData from './wordList.json';

/**
 * The words a Full text may carry, from SCOWL (Spell Checker Oriented Word Lists) sizes 10 to 40 in the American,
 * British, Canadian and Australian spellings, folded to plain lower-case letters. `everyday` holds sizes 10 and 20,
 * the most common words, and `more` holds sizes 35 and 40.
 */
const WORD_LIST: { everyday: readonly string[]; more: readonly string[] } = wordListData;

/** Every ASCII top-level domain in the IANA registry, such as com, net, ly, app and dentist. */
const WEB_ENDINGS: ReadonlySet<string> = new Set(webEndingsData);

/**
 * Endings people really write after a dot, which stay off the list even when they are everyday words, so a text
 * cannot spell a site with them. The rest of the web endings that are also very common words, such as call, today or
 * dentist, cannot be told from the same words in a sentence, and stay.
 */
// prettier-ignore
export const NEVER_ENDINGS = [
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'biz', 'info', 'mobi', 'asia', 'tel', 'xxx', 'io', 'co', 'ly',
  'us', 'uk', 'me', 'ai', 'app', 'dev', 'xyz', 'tv', 'cc', 'ws', 'fm', 'gg', 'sh', 'link', 'site', 'online',
  'website', 'web', 'blog', 'tech', 'download', 'hosting', 'cloud', 'click', 'tube',
] as const;

/** Words that read out a site's dot, such as evil dot help or evil point help. */
export const SPOKEN_DOT = ['dot', 'point', 'period'] as const;

/** Number words, spelled out. They stay off the list so a phone number cannot be read out in words. */
// prettier-ignore
export const NUMBER_WORDS = [
  'zero', 'oh', 'nought', 'nil', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'niner',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fourty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'double', 'triple',
] as const;

/**
 * Words a text may carry that no word list holds: the days and months by their full or short names, the titles
 * before a name, and the letters that stand for the euro, the pound and the yen.
 */
// prettier-ignore
const CALENDAR_WORDS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu',
  'thur', 'thurs', 'fri', 'sat', 'sun', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
  'oct', 'nov', 'dec', 'dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'eur', 'gbp', 'jpy',
] as const;

/** The only words of one letter. */
const ONE_LETTER_WORDS = ['a', 'i'] as const;

/** The words that stay off the list on purpose: a web ending, a spoken dot or a number word. */
const REMOVED: ReadonlySet<string> = new Set([...NEVER_ENDINGS, ...SPOKEN_DOT, ...NUMBER_WORDS]);

/** The longest word a person can add. */
export const CUSTOM_WORD_MAX = 24;

/** Whether a word is one of the web endings, spoken dots or number words that stay off the list on purpose. */
export function isRemovedWord(word: string): boolean {
  return REMOVED.has(foldWord(word));
}

/** Whether a word is any web ending, a spoken dot or a number word. */
export function isEndingOrNumber(word: string): boolean {
  const folded = foldWord(word);
  return WEB_ENDINGS.has(folded) || REMOVED.has(folded);
}

function buildKnown(): ReadonlySet<string> {
  const known = new Set<string>();
  for (const word of WORD_LIST.everyday) {
    known.add(word);
  }
  for (const word of WORD_LIST.more) {
    known.add(word);
  }
  for (const word of CALENDAR_WORDS) {
    known.add(word);
  }
  for (const word of REMOVED) {
    known.delete(word);
  }
  for (const word of [...known]) {
    if (word.length === 1 && !ONE_LETTER_WORDS.some(letter => letter === word)) {
      known.delete(word);
    }
  }
  return known;
}

let known: ReadonlySet<string> | undefined;

/** The words every Full text may carry, built from the list the first time they are asked for. */
export function knownWords(): ReadonlySet<string> {
  known ??= buildKnown();
  return known;
}

/** Whether a lower-case word of letters is on the list or among the words the person allowed. */
export function isAllowedWord({ word, extra }: { word: string; extra?: ReadonlySet<string> }): boolean {
  return knownWords().has(word) || extra?.has(word) === true;
}

/** A word as the list holds it: accents dropped and lower case. */
export function foldWord(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/**
 * Why a word cannot be added to the words Aman may text, or undefined when it can: letters only, not one of the web
 * endings, spoken dots or number words kept off the list, and not longer than a name should be.
 */
export function customWordProblem(word: string): string | undefined {
  const folded = foldWord(word);
  if (!/^[a-z]+$/.test(folded)) {
    return 'Use letters only, with no spaces, digits or signs.';
  }
  if (folded.length < 2 || folded.length > CUSTOM_WORD_MAX) {
    return `Use 2 to ${String(CUSTOM_WORD_MAX)} letters.`;
  }
  if (REMOVED.has(folded)) {
    return 'A web ending such as com or io, a spoken dot or a number word cannot be added. A text could use it to spell a link or a phone number.';
  }
  return undefined;
}
