import { compactForm, looksLikeWord, scanForm, type OutboundStrings } from './outboundGuard';

export type PrivateTextMode = 'search' | 'maps';

/** What the outgoing text carries from the private text: the first kind found. */
export type PrivateTextLeak = 'contact' | 'number' | 'name' | 'phrase' | 'token';

/** Five words in a row copied from the private text is a phrase; four is not. */
const COPIED_WORDS = 5;
/** A phrase must be this long without its spacing, so a run of short common words cannot trip the check. */
const MIN_PHRASE_CHARS = 16;
/** Fewest digits a phone number has, when written with a leading plus sign. */
const MIN_INTERNATIONAL_PHONE_DIGITS = 8;
/** Fewest digits a phone number has when written without one. Shorter runs are postal codes and dates. */
const MIN_PHONE_DIGITS = 10;
/** Fewest letters a full name needs before its joined form is matched inside the text. */
const MIN_JOINED_NAME_CHARS = 6;
/** A name is matched only when it has this many words: one word alone (a city, a surname, a common noun) is never a match. */
const MIN_NAME_WORDS = 2;
const MIN_EMAIL_CHARS = 10;
const MIN_ENCODED_TOKEN_CHARS = 20;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu;
/** A run of six or more digits, such as an order or booking number. */
const DIGIT_RUN = /\d{6,}/g;
const PHONE_CANDIDATE = /\+?\d(?:[\s().-]?\d){6,}/g;
const WORD = /[\p{L}\p{N}]+/gu;
const ENCODED_TOKEN = /[A-Za-z0-9+/]{20,}={0,2}/g;
/**
 * A From, To or Cc line of a mail, at the start of its line. Body text such as `Directions to: Park Clinic`
 * is not a header and is not read for names.
 */
const HEADER_LINE = /^[ \t]*(?:from|to|cc)[ \t]*:([^\n\r]*)/gim;
/** The same fields as JSON members, `"from": "Name <address>"`. The key must be quoted, so body text is not read as one. */
const JSON_HEADER = /"(?:from|to|cc)"[ \t]*:[ \t]*"([^"\n\r]*)"/gi;
/** A calendar attendee's or organizer's display name in JSON. */
const DISPLAY_NAME = /"displayName"\s*:\s*"([^"]*)"/gi;
/** One recipient of a header list: quoted text (which may hold a comma) or the text up to the next comma. */
const RECIPIENT = /(?:"[^"]*"|[^,"])+/g;
/** An address written in words: `maria dot costa at harbour dot example`. */
const SPELLED_AT = /\s*\bat\b\s*/gi;
const SPELLED_DOT = /\s*\bdot\b\s*/gi;

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/** The address the words of a folded text spell out, so `at` and `dot` read as the marks they stand for. */
function addressForm(folded: string): string {
  return folded.replace(SPELLED_AT, '@').replace(SPELLED_DOT, '.');
}

/**
 * Full names of the people a From, To or Cc header or a calendar display name gives, with any address
 * removed. A `Last, First` name also comes back in first-last order.
 */
function namesIn(text: string): string[] {
  const recipients: string[] = [];
  for (const match of text.matchAll(HEADER_LINE)) {
    recipients.push(...((match[1] ?? '').match(RECIPIENT) ?? []));
  }
  for (const match of text.matchAll(JSON_HEADER)) {
    recipients.push(...((match[1] ?? '').match(RECIPIENT) ?? []));
  }
  const names: string[] = [];
  for (const recipient of recipients) {
    const angle = recipient.indexOf('<');
    const name = (angle < 0 ? recipient : recipient.slice(0, angle)).replace(/^[\s"']+|[\s"']+$/g, '').trim();
    if (name.includes('@') || wordsOf(name).length < MIN_NAME_WORDS) {
      continue;
    }
    names.push(name);
    if (name.includes(',')) {
      names.push(
        name
          .split(',')
          .map(part => part.trim())
          .reverse()
          .join(' '),
      );
    }
  }
  for (const match of text.matchAll(DISPLAY_NAME)) {
    const name = (match[1] ?? '').trim();
    if (wordsOf(name).length >= MIN_NAME_WORDS) {
      names.push(name);
    }
  }
  return names;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** Every run of `size` words in the text, each run joined without spacing, as `compactForm` reads text. */
function wordRunsCompact(text: string, size: number): string[] {
  const words = wordsOf(text);
  const runs: string[] = [];
  for (let start = 0; start + size <= words.length; start += 1) {
    runs.push(words.slice(start, start + size).join(''));
  }
  return runs;
}

interface PrivateFacts {
  /** Addresses, compact, with the separators and spelled-out marks removed. */
  emails: Set<string>;
  /** Phone numbers as digits only. */
  phoneDigits: Set<string>;
  /** Runs of six or more digits. */
  numbers: Set<string>;
  /** Full names, compact, for names of two or more words. */
  joinedNames: Set<string>;
  /** Copied phrases, compact, keyed by their first `MIN_PHRASE_CHARS` characters. */
  phrasesByPrefix: Map<string, string[]>;
}

/** Facts read from the private texts, folded the same way as the outgoing text is. */
function privateFacts(privateTexts: readonly string[], mode: PrivateTextMode): PrivateFacts {
  const facts: PrivateFacts = {
    emails: new Set(),
    phoneDigits: new Set(),
    numbers: new Set(),
    joinedNames: new Set(),
    phrasesByPrefix: new Map(),
  };
  for (const raw of privateTexts) {
    const text = scanForm(raw);
    for (const match of addressForm(text).matchAll(EMAIL)) {
      const email = compactForm(match[0]);
      if (email.length >= MIN_EMAIL_CHARS) {
        facts.emails.add(email);
      }
    }
    for (const match of text.matchAll(PHONE_CANDIDATE)) {
      const digits = digitsOf(match[0]);
      const international = match[0].startsWith('+') && digits.length >= MIN_INTERNATIONAL_PHONE_DIGITS;
      if (international || digits.length >= MIN_PHONE_DIGITS) {
        facts.phoneDigits.add(digits);
      }
    }
    for (const match of text.matchAll(DIGIT_RUN)) {
      facts.numbers.add(match[0]);
    }
    for (const name of namesIn(text)) {
      const joined = compactForm(name);
      if (joined.length >= MIN_JOINED_NAME_CHARS) {
        facts.joinedNames.add(joined);
      }
    }
    if (mode === 'search') {
      for (const run of wordRunsCompact(text, COPIED_WORDS)) {
        if (run.length >= MIN_PHRASE_CHARS) {
          const prefix = run.slice(0, MIN_PHRASE_CHARS);
          facts.phrasesByPrefix.set(prefix, [...(facts.phrasesByPrefix.get(prefix) ?? []), run]);
        }
      }
    }
  }
  return facts;
}

/** Whether a copied phrase starts at any point of the compact text. Looks up each position by its prefix, so it stays fast. */
function copiesPhrase(compact: string, phrasesByPrefix: ReadonlyMap<string, readonly string[]>): boolean {
  for (let start = 0; start + MIN_PHRASE_CHARS <= compact.length; start += 1) {
    const candidates = phrasesByPrefix.get(compact.slice(start, start + MIN_PHRASE_CHARS));
    if (candidates?.some(phrase => compact.startsWith(phrase, start))) {
      return true;
    }
  }
  return false;
}

/** A long run that is not ordinary text: it has a digit, or it is letters with no word shape. */
function isEncodedToken(token: string): boolean {
  if (token.length < MIN_ENCODED_TOKEN_CHARS) {
    return false;
  }
  return /\d/.test(token) || (/^[A-Za-z]+$/.test(token) && !looksLikeWord(token));
}

/**
 * The first kind of private content the outgoing strings carry, or null when they carry none. Checks
 * whether a search or map copies the mail or calendar text this chat read. A map may name a street
 * address from it, since routing there is the point; a search may not copy phrases or names.
 *
 * Both sides are folded the same way first: look-alike letters, percent escapes, case, spacing and
 * punctuation. `earlier` is the text this turn already sent, so a copy split across calls is seen whole.
 */
export function privateTextLeak(input: {
  mode: PrivateTextMode;
  strings: OutboundStrings;
  earlier: string;
  privateTexts: readonly string[];
}): PrivateTextLeak | null {
  const { mode, privateTexts } = input;
  if (privateTexts.length === 0) {
    return null;
  }
  const outgoing = [...input.strings.values, ...input.strings.scalars, ...input.strings.plumbing].map(scanForm);
  const text = [input.earlier, ...outgoing].join(' ');
  const facts = privateFacts(privateTexts, mode);
  const address = compactForm(addressForm(text));
  for (const email of facts.emails) {
    if (address.includes(email)) {
      return 'contact';
    }
  }
  const digits = digitsOf(text);
  for (const phone of facts.phoneDigits) {
    if (digits.includes(phone)) {
      return 'contact';
    }
  }
  for (const run of facts.numbers) {
    if (digits.includes(run)) {
      return 'number';
    }
  }
  const compact = compactForm(text);
  for (const name of facts.joinedNames) {
    if (compact.includes(name)) {
      return 'name';
    }
  }
  if (mode === 'search' && copiesPhrase(compact, facts.phrasesByPrefix)) {
    return 'phrase';
  }
  for (const match of text.matchAll(ENCODED_TOKEN)) {
    if (isEncodedToken(match[0])) {
      return 'token';
    }
  }
  return null;
}
