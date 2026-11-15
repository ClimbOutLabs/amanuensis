import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore } from '../../db/textContactStore';
import type { Delivery, DeliveryKind } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';
import { customWordProblem, isAllowedWord, isEndingOrNumber } from './knownWords';

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

/**
 * The most digits a Full text may hold in all, in times, dates, amounts and codes, so it cannot hold a phone number
 * with its area code. A short code of 5 or 6 digits still fits.
 */
const MAX_DIGITS = 6;

const TIME_PART = '\\d{1,2}(?:[:.]\\d{2})?(?:[ap]\\.?m\\.?)?';
/** A range of two times or days, such as 3-4pm or 7:30-9:30, read as two with "to" between. */
const RANGE = new RegExp(`(?<![\\d:./-])(${TIME_PART})\\s?-\\s?(?=${TIME_PART}(?![\\d:/-]|\\.\\d))`, 'g');
/** A time with a space before am or pm, such as 3 pm, read as one word. */
const SPACED_AM_PM = /(\d)\s([ap]\.?m\.?)(?![a-z])/g;
/** The signs a sentence may end a word with: a comma, a full stop, a question mark or an exclamation mark. */
const ENDING_SIGNS = /[.,?!]{1,3}$/;
/** A word of letters, with a dash or an apostrophe only inside it, or an apostrophe after a final s, as in Smiths'. */
const WORD = /^[a-z]+(?:['-][a-z]+)*(?:(?<=s)')?$/;
/** What may follow an apostrophe: the rest of a contraction or a possessive, such as 's, 'll or n't. */
const APOSTROPHE_ENDS = new Set(['s', 'd', 'll', 're', 've', 'm', 't']);
/** The stems before n't that are not words on their own, such as ca in can't. */
const NT_STEMS = new Set(['ca', 'wo', 'sha', 'ai']);
/** An amount or a count: a dollar sign before, a percent after, thousands commas and decimals inside. */
const NUMBER = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
/** A short code of letters and digits, such as Q3, AA100, 5k or 100mg. */
const CODE = /^(?:[a-z]{1,3}\d{1,4}|\d{1,4}[a-z]{1,3})$/;
const AM_PM_TIME = /^(\d{1,2})(?:[:.](\d{2}))?([ap])\.?m$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
/** The toll-free prefixes, which read out as a phone number when a word follows, such as 1 800 flowers. */
const TOLL_FREE = /^1?(?:800|833|844|855|866|877|888)$/;
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
  if (ORDINAL.test(word)) {
    return { digits, bare: false };
  }
  // The letters of a code, such as the k of 5k, must not be a web ending, as in 1com.
  return CODE.test(word) && !isEndingOrNumber(word.replace(/\d/g, '')) ? { digits, bare: false } : undefined;
}

/** Whether a day next to a month names a day that month never has, such as Feb 31. */
function impossibleDay({ month, day }: { month: string | undefined; day: string | undefined }): boolean {
  const most = MONTH_DAYS.get(month ?? '');
  const number = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(day ?? '')?.[1];
  return most !== undefined && number !== undefined && !inRange({ value: number, low: 1, high: most });
}

/** Whether every part of a word of letters is on the list, reading a dash or an apostrophe as a join. */
function wordAllowed({ word, extra }: { word: string; extra: ReadonlySet<string> }): boolean {
  return word.split('-').every(part => {
    if (isAllowedWord({ word: part, extra })) {
      return true;
    }
    const [stem, end, ...rest] = part.split("'");
    if (stem === undefined || rest.length > 0) {
      return false;
    }
    if (end === undefined) {
      return isAllowedWord({ word: stem, extra });
    }
    // A plural possessive, such as the Smiths', is the plural with an apostrophe after its s.
    if (end === '') {
      return stem.endsWith('s') && isAllowedWord({ word: stem, extra });
    }
    if (stem === 'o' && end === 'clock') {
      return true;
    }
    if (end === 't' && stem.endsWith('n')) {
      const base = stem.slice(0, -1);
      return NT_STEMS.has(base) || isAllowedWord({ word: base, extra });
    }
    return APOSTROPHE_ENDS.has(end) && end !== 't' && isAllowedWord({ word: stem, extra });
  });
}

/**
 * The first word that keeps this text from going out in Full, or undefined when every word is allowed. The text is read
 * in its cleaned form, so what is checked is what a phone would show. `extra` holds the words allowed besides the list: the
 * assistant's name and the words the person added.
 * A word is allowed when it is on the list of known words or among the person's own, or has a known shape: an
 * amount or a count, an ordinal, a short code of letters and digits, or a time or a date in range. A comma, a full
 * stop, a question mark or an exclamation mark may end a word, and a dash or an apostrophe may sit inside one. The
 * digits in all of them come to at most 6, so the words cannot hold a phone number with its area code.
 */
export function heldBackWord({
  text,
  extra = NO_WORDS,
}: {
  text: string;
  extra?: ReadonlySet<string> | undefined;
}): string | undefined {
  const odd = /\p{Sc}/u.exec(text.replace(KNOWN_CURRENCY, ''));
  if (odd !== null) {
    return odd[0];
  }
  const tokens = plainText(text)
    .toLowerCase()
    .replace(SPACED_AM_PM, '$1$2')
    .replace(RANGE, '$1 to ')
    .split(/\s+/)
    .filter(token => token !== '');
  const words = tokens.map(token => token.replace(ENDING_SIGNS, ''));
  let digits = 0;
  let numberRun = 0;
  for (const [index, word] of words.entries()) {
    const token = tokens[index] ?? word;
    if (!WORD.test(word)) {
      const counted = digitWord(word);
      const next = words[index + 1];
      const previous = words[index - 1];
      if (counted === undefined) {
        return token;
      }
      if (
        impossibleDay({ month: previous, day: word }) ||
        impossibleDay({ month: next === 'of' ? words[index + 2] : next, day: word })
      ) {
        return token;
      }
      if (TOLL_FREE.test(word) && next !== undefined && /^[a-z]{4,}/.test(next)) {
        return token;
      }
      digits += counted.digits;
      numberRun = counted.bare ? numberRun + 1 : 0;
      if (numberRun >= 3 || digits > MAX_DIGITS) {
        return token;
      }
      continue;
    }
    numberRun = 0;
    if (!wordAllowed({ word, extra })) {
      return token;
    }
  }
  return undefined;
}

const NO_WORDS: ReadonlySet<string> = new Set();

/** Whether a Full text may carry these words. See `heldBackWord`. */
export function isPlainWords(text: string, extra?: ReadonlySet<string>): boolean {
  return heldBackWord({ text, extra }) === undefined;
}

/**
 * The words a Full text may carry, in the exact form they are sent, or undefined. The only way to get words for a Full
 * text, so none goes out that was not checked as sent: the text as given passes, and so do the cleaned and cut words.
 */
export function checkedWords({
  text,
  room,
  extra,
}: {
  text: string;
  room: number;
  extra?: ReadonlySet<string> | undefined;
}): string | undefined {
  return checkWords({ text, room, extra }).words;
}

/** What `checkedWords` finds, and the first word that held the text back when it finds none. */
export function checkWords({
  text,
  room,
  extra,
}: {
  text: string;
  room: number;
  extra?: ReadonlySet<string> | undefined;
}): {
  words: string | undefined;
  held: string | undefined;
} {
  const held = heldBackWord({ text, extra });
  if (held !== undefined) {
    return { words: undefined, held };
  }
  const sent = cut({ text: plainText(text), room });
  const heldSent = heldBackWord({ text: sent, extra });
  return heldSent === undefined ? { words: sent, held: undefined } : { words: undefined, held: heldSent };
}

/** The words of the assistant's name, such as O'Neil and its parts, which a text may repeat. */
export function nameWords(name: string): Set<string> {
  const words = name
    .toLowerCase()
    .split(/[^a-z']+/)
    .flatMap(word => [word.replace(/^'+|'+$/g, ''), ...word.split("'")]);
  // A single letter is no word, in a name as anywhere else, so a name cannot spell a link letter by letter.
  return new Set(words.filter(word => word.length > 1));
}

/**
 * The words a text or a call may carry besides the list: the words the person added, each checked again against the
 * rules for an added word, and the words of the assistant's name. The one owner of this set, for texts and calls alike.
 */
export async function allowedExtraWords({
  contacts,
  owner,
  name,
}: {
  contacts: Pick<ITextContactStore, 'listWords'>;
  owner: PersonOwner;
  name: string;
}): Promise<ReadonlySet<string>> {
  const added = (await contacts.listWords(owner)).filter(word => customWordProblem(word) === undefined);
  return new Set([...added, ...nameWords(name)]);
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
  extra,
}: {
  name: string;
  delivery: Delivery;
  mode: TextMode;
  test: boolean;
  /** The words a text may carry besides the list, from `allowedExtraWords`. */
  extra?: ReadonlySet<string> | undefined;
}): {
  body: string;
  withheld: FullWithheld;
  /** The first word that held a Full text back, when `withheld` is `not_plain_words`. */
  held: string | null;
} {
  const privateBody = privateText({ name, kind: delivery.kind });
  if (mode === 'private') {
    return { body: privateBody, withheld: null, held: null };
  }
  if (!test && !OWN_WORDS_KINDS.has(delivery.kind)) {
    return { body: privateBody, withheld: 'noticed', held: null };
  }
  const prefix = `${name}: `;
  const { words, held } = checkWords({ text: delivery.text, room: TEXT_MAX - prefix.length, extra });
  if (words === undefined) {
    return { body: privateBody, withheld: 'not_plain_words', held: held ?? null };
  }
  return { body: `${prefix}${words}`, withheld: null, held: null };
}

/** The code text. It carries no name the person chose, because it goes to a number nobody has proved yet. */
export function codeText(code: string): string {
  return `Your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`;
}
