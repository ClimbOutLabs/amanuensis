import type { Delivery, DeliveryKind } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';

/** Said wherever texts are asked for on a server that has no Twilio details. */
export const TEXTS_NOT_SET_UP =
  'Texts are not set up on this server. To set them up, follow the Text messages page in the Aman docs.';

/** Two text segments of plain characters. A longer message is cut at a word and ends with three dots. */
const TEXT_MAX = 306;

/** Characters that would make the phone company send the whole text in its costlier long form, and what stands in. */
const STAND_INS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '`': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '~': '-',
  '…': '...',
  '{': '(',
  '}': ')',
  '[': '(',
  ']': ')',
  '|': '/',
  '\\': '/',
};

/**
 * The text in characters that each take one place in a text message: accents are dropped, quotes and dashes become
 * plain ones, and anything else outside that set, such as an emoji, is left out.
 */
export function plainText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’`“”–—~…{}[\]|\\]/g, char => STAND_INS[char] ?? '')
    .replace(/[^\x20-\x7E]|\^/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a Private text says: only the kind of thing. It never carries a name, an amount or any content, because a
 * text can show on a locked screen and travels through the phone company.
 */
export function privatePhrase(kind: DeliveryKind): string {
  switch (kind) {
    case 'reminder':
      return 'a reminder is due';
    case 'note':
      return 'a note is waiting';
    case 'nudge':
      return 'something needs you';
    case 'approval_waiting':
      return 'something is waiting for your ok';
  }
}

export function privateText({ name, kind }: { name: string; kind: DeliveryKind }): string {
  return `${name}: ${privatePhrase(kind)}. Open the app to see it.`;
}

function cut({ text, room }: { text: string; room: number }): string {
  if (text.length <= room) {
    return text;
  }
  const head = text.slice(0, room - 3);
  const space = head.lastIndexOf(' ');
  return `${(space > room / 2 ? head.slice(0, space) : head).trimEnd()}...`;
}

// prettier-ignore
const MONTHS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug',
  'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
]);
const MONTH = '([a-z]+)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s+(\\d{4}))?';
/** Digits glued to a letter, a dot, a colon, a slash or a dash are part of something longer than a time or a date. */
const BEFORE = '(?<![a-z0-9.:/-])';
const AFTER = '(?![a-z0-9:/-]|\\.[a-z0-9])';

function inRange({ value, low, high }: { value: string | undefined; low: number; high: number }): boolean {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number >= low && number <= high;
}

const isDay = (value: string | undefined) => inRange({ value, low: 1, high: 31 });
const isMonth = (value: string | undefined) => inRange({ value, low: 1, high: 12 });
const isMinute = (value: string | undefined) => value === undefined || inRange({ value, low: 0, high: 59 });
const isYear = (value: string | undefined) => value === undefined || /^(?:19|20)\d\d$/.test(value);
const isOrdinal = (whole: string, day: string | undefined) =>
  isDay(day) && /^(?:1st|2nd|3rd|21st|22nd|23rd|31st|(?:[4-9]|1\d|2[04-9]|30)th)$/.test(whole.replace(/^0/, ''));

/**
 * Times and dates written the usual ways, each with its parts in range: a day 1 to 31, a month by its whole name,
 * an hour 0 to 23 or 1 to 12 before am or pm, minutes 00 to 59, and a year in the 1900s or 2000s.
 */
const TIME_AND_DATE_SHAPES: readonly {
  shape: RegExp;
  fits: (parts: (string | undefined)[], whole: string) => boolean;
}[] = [
  {
    shape: new RegExp(`${BEFORE}${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR}${AFTER}`, 'g'),
    fits: ([day, month, year]) => isDay(day) && MONTHS.has(month ?? '') && isYear(year),
  },
  {
    shape: new RegExp(`${BEFORE}${MONTH}\\s+${DAY}${YEAR}${AFTER}`, 'g'),
    fits: ([month, day, year]) => isDay(day) && MONTHS.has(month ?? '') && isYear(year),
  },
  {
    shape: new RegExp(`${BEFORE}(\\d{4})-(\\d{2})-(\\d{2})${AFTER}`, 'g'),
    fits: ([year, month, day]) => isYear(year) && isMonth(month) && isDay(day),
  },
  {
    shape: new RegExp(`${BEFORE}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?${AFTER}`, 'g'),
    fits: ([first, second, year]) =>
      isDay(first) && isDay(second) && (isMonth(first) || isMonth(second)) && (year?.length !== 4 || isYear(year)),
  },
  {
    shape: new RegExp(`${BEFORE}(\\d{1,2})(?:[:.](\\d{2}))?\\s?[ap]\\.?m\\.?(?![a-z0-9])`, 'g'),
    fits: ([hour, minute]) => inRange({ value: hour, low: 1, high: 12 }) && isMinute(minute),
  },
  {
    shape: new RegExp(`${BEFORE}(\\d{1,2})[:.](\\d{2})${AFTER}`, 'g'),
    fits: ([hour, minute]) => inRange({ value: hour, low: 0, high: 23 }) && isMinute(minute),
  },
  {
    shape: new RegExp(`${BEFORE}(\\d{1,2})(?:st|nd|rd|th)${AFTER}`, 'g'),
    fits: ([day], whole) => isOrdinal(whole, day),
  },
];

/** Stands in for a time or a date while the words are checked. Plain text never holds it. */
const SHAPE = '\u0000';
const SMALL_NUMBER = /^\d{1,2}$/;
const WORD = /^[a-z]+(?:['-][a-z]+)*$/;
/** Punctuation a sentence puts before or after a word. Anywhere else in a word, it could join the parts of a site. */
const EDGES = /^[("']+|[)"'.,!?;:]+$/g;
/** Standing alone, these join words rather than spell anything. */
const JOINS = new Set(['-', '&', '+']);
/** Words that read out a site: a spoken dot or slash, or a web cue. */
const SPOKEN_SITE = new Set(['dot', 'slash', 'backslash', 'www', 'http', 'https', 'url', 'com']);
// prettier-ignore
const NUMBER_WORDS = new Set([
  'zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'double', 'triple',
]);
/** The most digits, times and dates one Full text may hold, so a run of them cannot spell a number to call. */
const MAX_DIGIT_TOKENS = 2;

/** The text with each time and date that is in range put as one stand-in, and anything else left as it was. */
function withShapes(text: string): string {
  return TIME_AND_DATE_SHAPES.reduce(
    (rest, { shape, fits }) =>
      rest.replace(shape, (whole: string, ...groups: unknown[]) => {
        const parts = groups.slice(0, -2).map(group => (typeof group === 'string' ? group : undefined));
        return fits(parts, whole) ? ` ${SHAPE} ` : whole;
      }),
    text,
  );
}

/** Whether words in a row read out a number: three number words, or two that end in hundred or thousand. */
function readsOutNumber(words: readonly string[]): boolean {
  let run = 0;
  for (const word of words) {
    if (NUMBER_WORDS.has(word)) {
      run += 1;
      if (run >= 3 || (run >= 2 && (word === 'hundred' || word === 'thousand'))) {
        return true;
      }
    } else if (word !== 'and') {
      run = 0;
    }
  }
  return false;
}

/** Whether three single letters stand in a row, which can spell a site or a number letter by letter. */
function spellsLetters(words: readonly string[]): boolean {
  let run = 0;
  for (const word of words) {
    run = /^[a-z]$/.test(word) ? run + 1 : 0;
    if (run >= 3) {
      return true;
    }
  }
  return false;
}

/**
 * Whether these words could carry a number to call, a site or an address. Only known shapes pass: words, small
 * numbers, and times and dates in range, at most two holding digits and never two side by side. Anything else, such
 * as a sign inside a word, a long number, single letters in a row or a site or a number read out in words, fails. A
 * false alarm only costs the item's own words, which stay in the app. This is the one check for words a text carries.
 */
export function mayCarryContactDetail(text: string): boolean {
  const tokens = withShapes(plainText(text).toLowerCase())
    .split(/\s+/)
    .filter(token => token !== '');
  let digitTokens = 0;
  let lastHadDigits = false;
  for (const token of tokens) {
    const word = token.replace(EDGES, '');
    if (word === '' || JOINS.has(token)) {
      // Punctuation alone neither spells anything nor parts two numbers.
      continue;
    }
    const hasDigits = token === SHAPE || SMALL_NUMBER.test(word);
    if (!hasDigits && !WORD.test(word)) {
      return true;
    }
    if (SPOKEN_SITE.has(word) || (word === 'at' && token.startsWith('('))) {
      return true;
    }
    if (hasDigits && lastHadDigits) {
      return true;
    }
    digitTokens += hasDigits ? 1 : 0;
    lastHadDigits = hasDigits;
  }
  const words = plainText(text)
    .toLowerCase()
    .split(/[\s,;.()_-]+/)
    .filter(word => word !== '');
  return digitTokens > MAX_DIGIT_TOKENS || readsOutNumber(words) || spellsLetters(words);
}

/** Why a Full text went out in Private words instead, or null when it carried the item's own words. */
export type FullWithheld = 'noticed' | 'not_plain_words' | null;

/** Kinds whose words the person asked for. What the assistant noticed is worded by the model and stays in the app. */
const OWN_WORDS_KINDS: ReadonlySet<DeliveryKind> = new Set(['reminder']);

/**
 * The text that goes out for a delivery, given the name already made fit for a text. Full carries the item's words
 * only for a reminder or a Try it test; anything noticed goes out in Private words. Words that are not plain words,
 * times and dates also go out in Private words, since a text is where a link or a number to call does the most harm.
 */
export function textBody({
  name,
  delivery,
  mode,
  test,
}: {
  name: string;
  delivery: Delivery;
  mode: TextMode;
  test: boolean;
}): {
  body: string;
  withheld: FullWithheld;
} {
  const privateBody = privateText({ name, kind: delivery.kind });
  if (mode === 'private') {
    return { body: privateBody, withheld: null };
  }
  if (!test && !OWN_WORDS_KINDS.has(delivery.kind)) {
    return { body: privateBody, withheld: 'noticed' };
  }
  if (mayCarryContactDetail(delivery.text)) {
    return { body: privateBody, withheld: 'not_plain_words' };
  }
  const plain = plainText(delivery.text);
  const prefix = `${name}: `;
  return { body: `${prefix}${cut({ text: plain, room: TEXT_MAX - prefix.length })}`, withheld: null };
}

/** The code text. It carries no name the person chose, because it goes to a number nobody has proved yet. */
export function codeText(code: string): string {
  return `Your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`;
}
