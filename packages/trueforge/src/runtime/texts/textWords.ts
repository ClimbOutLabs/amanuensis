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
  '€': ' EUR ',
  '£': ' GBP ',
  '¥': ' JPY ',
};

/**
 * The text in characters that each take one place in a text message: accents are dropped, quotes and dashes become
 * plain ones, the euro, pound and yen signs become their letters, and anything else outside that set, such as an
 * emoji, is left out.
 */
export function plainText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’`“”–—~…{}[\]|\\€£¥]/g, char => STAND_INS[char] ?? '')
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

/** Each month by its full or short name, with the most days it can have. */
// prettier-ignore
const MONTH_DAYS = new Map<string, number>([
  ['jan', 31], ['january', 31], ['feb', 29], ['february', 29], ['mar', 31], ['march', 31], ['apr', 30],
  ['april', 30], ['may', 31], ['jun', 30], ['june', 30], ['jul', 31], ['july', 31], ['aug', 31], ['august', 31],
  ['sep', 30], ['sept', 30], ['september', 30], ['oct', 31], ['october', 31], ['nov', 30], ['november', 30],
  ['dec', 31], ['december', 31],
]);

/** How many digits each number word stands for, so a number read out in words counts like one in digits. */
// prettier-ignore
const NUMBER_WORDS = new Map<string, number>([
  ['zero', 1], ['oh', 1], ['nought', 1], ['one', 1], ['two', 1], ['three', 1], ['four', 1], ['five', 1], ['six', 1],
  ['seven', 1], ['eight', 1], ['nine', 1], ['niner', 1], ['ten', 2], ['eleven', 2], ['twelve', 2], ['thirteen', 2],
  ['fourteen', 2], ['fifteen', 2], ['sixteen', 2], ['seventeen', 2], ['eighteen', 2], ['nineteen', 2],
  ['twenty', 2], ['thirty', 2], ['forty', 2], ['fourty', 2], ['fifty', 2], ['sixty', 2], ['seventy', 2],
  ['eighty', 2], ['ninety', 2], ['hundred', 2], ['thousand', 3], ['double', 1], ['triple', 2],
]);

/**
 * The most digits a Full text may hold in all, in times, dates, amounts, codes or number words, so it cannot hold a
 * phone number with its area code. A short code of 5 or 6 digits still fits.
 */
const MAX_DIGITS = 6;

const TIME_PART = '\\d{1,2}(?:[:.]\\d{2})?(?:[ap]\\.?m\\.?)?';
/** A range of two times or days, such as 3-4pm or 7:30-9:30, read as two with "to" between. */
const RANGE = new RegExp(`(?<![\\d:./-])(${TIME_PART})\\s?-\\s?(?=${TIME_PART}(?![\\d:/-]|\\.\\d))`, 'g');
/** A time with a space before am or pm, such as 3 pm, read as one word. */
const SPACED_AM_PM = /(\d)\s([ap]\.?m\.?)(?![a-z])/g;
/** Punctuation a sentence puts before or after a word. Anywhere else in a word, it could join the parts of a site. */
const EDGES = /^[("']+|[)"'.,!?;:]+$/g;
/** Standing alone, these join words rather than spell anything. */
const JOINS = new Set(['-', '&']);
const WORD = /^[a-z]+(?:['-][a-z]+)*$/;
/** Two single letters with dots, such as e.g. or U.S. */
const ABBREVIATION = /^[a-z]\.[a-z]$/;
/** An amount or a count: a dollar sign before, a percent after, thousands commas and decimals inside. */
const NUMBER = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
/** A short code of letters and digits, such as Q3, AA100, 5k or 100mg. */
const CODE = /^(?:[a-z]{1,3}\d{1,4}|\d{1,4}[a-z]{1,3})$/;
const AM_PM_TIME = /^(\d{1,2})(?:[:.](\d{2}))?([ap])\.?m$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
/** Endings that make a spoken dot read out a site, such as evil dot com. */
const SITE_ENDINGS = new Set(['com', 'net', 'org', 'io', 'co', 'uk', 'us', 'info', 'biz', 'app', 'dev', 'me', 'ai']);
/** Words that only ever start a site. */
const SITE_WORDS = new Set(['www', 'http', 'https']);
/** Currency signs plainText writes as letters; any other one is dropped, and would change the amount's meaning. */
const KNOWN_CURRENCY = /[$€£¥]/g;

function inRange({ value, low, high }: { value: string | undefined; low: number; high: number }): boolean {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number >= low && number <= high;
}

const isMinute = (value: string | undefined) => value === undefined || inRange({ value, low: 0, high: 59 });
const isYear = (value: string | undefined) => value === undefined || /^(?:19|20)\d\d$/.test(value);

/** A word that holds digits, or undefined when it is not a known shape or a time or a date is out of range. */
function digitWord(word: string): { digits: number; bare: boolean } | undefined {
  const digits = word.replace(/\D/g, '').length;
  const amPm = AM_PM_TIME.exec(word);
  if (amPm !== null) {
    return inRange({ value: amPm[1], low: 1, high: 12 }) && isMinute(amPm[2]) ? { digits, bare: false } : undefined;
  }
  const clock = CLOCK_TIME.exec(word);
  if (clock !== null) {
    return inRange({ value: clock[1], low: 0, high: 23 }) && isMinute(clock[2]) ? { digits, bare: false } : undefined;
  }
  const iso = ISO_DATE.exec(word);
  if (iso !== null) {
    const fits =
      isYear(iso[1]) && inRange({ value: iso[2], low: 1, high: 12 }) && inRange({ value: iso[3], low: 1, high: 31 });
    return fits ? { digits, bare: false } : undefined;
  }
  const slashed = SLASHED_DATE.exec(word);
  if (slashed !== null) {
    const [first, second, year] = [slashed[1], slashed[2], slashed[3]];
    const fits =
      inRange({ value: first, low: 1, high: 31 }) &&
      inRange({ value: second, low: 1, high: 31 }) &&
      (inRange({ value: first, low: 1, high: 12 }) || inRange({ value: second, low: 1, high: 12 })) &&
      (year?.length !== 4 || isYear(year));
    return fits ? { digits, bare: false } : undefined;
  }
  if (NUMBER.test(word)) {
    return { digits, bare: true };
  }
  return ORDINAL.test(word) || CODE.test(word) ? { digits, bare: false } : undefined;
}

/** Whether a day next to a month names a day that month never has, such as Feb 31. */
function impossibleDay({ month, day }: { month: string | undefined; day: string | undefined }): boolean {
  const most = MONTH_DAYS.get(month ?? '');
  const number = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(day ?? '')?.[1];
  return most !== undefined && number !== undefined && !inRange({ value: number, low: 1, high: most });
}

/**
 * Whether a Full text may carry these words. Every word must have a known shape: a word of letters, an amount or a
 * count, an ordinal, a short code of letters and digits, or a time or a date in range. The digits in all of them,
 * and in number words, come to at most 6, so the words cannot hold a phone number with its area code. A site's
 * shape, three single letters in a row, or three numbers in a row also fail. A false alarm only costs the item's own
 * words, which stay in the app. This is the one check for words a text carries.
 */
export function isPlainWords(text: string): boolean {
  if (/\p{Sc}/u.test(text.replace(KNOWN_CURRENCY, ''))) {
    return false;
  }
  const plain = plainText(text).toLowerCase();
  if (/\(\s*at\s*\)/.test(plain)) {
    return false;
  }
  const words = plain
    .replace(SPACED_AM_PM, '$1$2')
    .replace(RANGE, '$1 to ')
    .split(/\s+/)
    .filter(token => token !== '' && !JOINS.has(token))
    .map(token => token.replace(EDGES, ''))
    .filter(word => word !== '');
  let digits = 0;
  let numberRun = 0;
  let letterRun = 0;
  for (const [index, word] of words.entries()) {
    const previous = words[index - 1];
    const next = words[index + 1];
    const spoken = NUMBER_WORDS.get(word);
    const counted = spoken === undefined && !WORD.test(word) ? digitWord(word) : undefined;
    const plainWord = WORD.test(word) || ABBREVIATION.test(word) || word === 'w/';
    if (!plainWord && counted === undefined) {
      return false;
    }
    if (SITE_WORDS.has(word) || (word === 'dot' && SITE_ENDINGS.has(next ?? ''))) {
      return false;
    }
    if (
      impossibleDay({ month: previous, day: word }) ||
      impossibleDay({ month: next === 'of' ? words[index + 2] : next, day: word })
    ) {
      return false;
    }
    digits += spoken ?? counted?.digits ?? 0;
    // A number read out in a row: number words and bare numbers alike, joined by "and".
    if (spoken !== undefined || counted?.bare === true) {
      numberRun += 1;
      if (numberRun >= 3 || (numberRun >= 2 && (word === 'hundred' || word === 'thousand'))) {
        return false;
      }
    } else if (word !== 'and') {
      numberRun = 0;
    }
    // Single letters in a row spell a site or a number letter by letter, also when joined by dashes.
    for (const part of word.split('-')) {
      letterRun = /^[a-z]$/.test(part) ? letterRun + 1 : 0;
      if (letterRun >= 3) {
        return false;
      }
    }
  }
  return digits <= MAX_DIGITS;
}

/** Why a Full text went out in Private words instead, or null when it carried the item's own words. */
export type FullWithheld = 'noticed' | 'not_plain_words' | null;

/** Kinds whose words the person asked for. What the assistant noticed is worded by the model and stays in the app. */
const OWN_WORDS_KINDS: ReadonlySet<DeliveryKind> = new Set(['reminder']);

/**
 * The text that goes out for a delivery, given the name already made fit for a text. Full carries the item's words
 * only for a reminder or the fixed Try it words; anything noticed goes out in Private words. Words that are not plain
 * words also go out in Private words, since a text is where a link or a number to call does the most harm.
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
  if (!isPlainWords(delivery.text)) {
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
