import { createHash } from 'node:crypto';

import { z } from 'zod';

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
/** Fewest letters a full name needs before it is matched in the text. */
const MIN_NAME_CHARS = 6;
/** A name is matched only when it has this many words: one word alone (a city, a surname, a common noun) is never a match. */
const MIN_NAME_WORDS = 2;
const MIN_EMAIL_CHARS = 10;
const MIN_ENCODED_TOKEN_CHARS = 20;

/** Most fingerprints one chat keeps. Past it the chat's checks are lost, so its later searches ask. */
export const MAX_PRIVATE_FINGERPRINTS = 20_000;

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

/**
 * One piece of a private text, kept as a hash so a later check can match it without the text. `length` is
 * characters for an address, digits, a number or a phrase, and words for a name. A compact name is one word.
 */
export const PrivateFingerprintSchema = z.object({
  kind: z.enum(['email', 'phone', 'number', 'name', 'phrase']),
  length: z.number().int().positive(),
  digest: z.string(),
});
export type PrivateFingerprint = z.infer<typeof PrivateFingerprintSchema>;

/**
 * What a chat keeps across its turns for the checks: fingerprints of every private text it read. `complete`
 * is false when some read left no text to fingerprint, so a check could miss a copy and the chat must ask.
 * `secret` is set once the chat read a secret or key file, which no grant lifts.
 */
export const ChatPrivateFingerprintsSchema = z.object({
  complete: z.boolean(),
  has_text: z.boolean(),
  secret: z.boolean(),
  entries: z.array(PrivateFingerprintSchema),
});
export type ChatPrivateFingerprints = z.infer<typeof ChatPrivateFingerprintsSchema>;

export function emptyChatPrivateFingerprints(): ChatPrivateFingerprints {
  // A chat with no private read yet has nothing it could miss, so it starts complete.
  return { complete: true, has_text: false, secret: false, entries: [] };
}

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

/** A long run that is not ordinary text: it has a digit, or it is letters with no word shape. */
function isEncodedToken(token: string): boolean {
  if (token.length < MIN_ENCODED_TOKEN_CHARS) {
    return false;
  }
  return /\d/.test(token) || (/^[A-Za-z]+$/.test(token) && !looksLikeWord(token));
}

function digestOf(input: { kind: PrivateFingerprint['kind']; value: string }): string {
  // Hashed with the kind, so a digit run and a phone number that read the same are told apart.
  return createHash('sha256').update(`${input.kind}\u0000${input.value}`).digest('hex').slice(0, 32);
}

function fingerprintKey(entry: PrivateFingerprint): string {
  return `${entry.kind}:${String(entry.length)}:${entry.digest}`;
}

/**
 * Fingerprints of the private texts, each folded the same way the outgoing text is, so a copy matches however
 * it was written. A name is kept both spaced and run together, since either can appear in the outgoing text.
 */
export function fingerprintsOf(privateTexts: readonly string[]): PrivateFingerprint[] {
  const found = new Map<string, PrivateFingerprint>();
  const add = (kind: PrivateFingerprint['kind'], length: number, value: string): void => {
    const entry = { kind, length, digest: digestOf({ kind, value }) };
    found.set(fingerprintKey(entry), entry);
  };
  for (const raw of privateTexts) {
    const text = scanForm(raw);
    for (const match of addressForm(text).matchAll(EMAIL)) {
      const email = compactForm(match[0]);
      if (email.length >= MIN_EMAIL_CHARS) {
        add('email', email.length, email);
      }
    }
    for (const match of text.matchAll(PHONE_CANDIDATE)) {
      const digits = digitsOf(match[0]);
      const international = match[0].startsWith('+') && digits.length >= MIN_INTERNATIONAL_PHONE_DIGITS;
      if (international || digits.length >= MIN_PHONE_DIGITS) {
        add('phone', digits.length, digits);
      }
    }
    for (const match of text.matchAll(DIGIT_RUN)) {
      add('number', match[0].length, match[0]);
    }
    for (const name of namesIn(text)) {
      const words = wordsOf(name);
      if (compactForm(name).length >= MIN_NAME_CHARS) {
        add('name', words.length, words.join(' '));
        add('name', 1, words.join(''));
      }
    }
    for (const run of wordRunsCompact(text, COPIED_WORDS)) {
      if (run.length >= MIN_PHRASE_CHARS) {
        add('phrase', run.length, run);
      }
    }
  }
  return [...found.values()];
}

/**
 * Adds the fingerprints of one more private text to a chat's kept state. Returns false, and keeps nothing more,
 * once the chat is over its cap, so the caller can mark the state lost.
 */
export function addPrivateFingerprints(input: { state: ChatPrivateFingerprints; text: string }): boolean {
  const merged = new Map(input.state.entries.map(entry => [fingerprintKey(entry), entry]));
  for (const entry of fingerprintsOf([input.text])) {
    merged.set(fingerprintKey(entry), entry);
  }
  if (merged.size > MAX_PRIVATE_FINGERPRINTS) {
    return false;
  }
  input.state.entries = [...merged.values()];
  input.state.has_text = true;
  return true;
}

/**
 * The first kind of private content the outgoing strings carry, or null when they carry none. Each fingerprint is
 * looked for as a copy at any place in the folded text: an address or digits anywhere, a name as whole words, and
 * a phrase as a run of the compact text. `earlier` is the text this turn already sent, so a copy split across calls
 * is seen whole. A map may name a street address from the private text, so maps skip phrases.
 */
export function fingerprintLeak(input: {
  mode: PrivateTextMode;
  strings: OutboundStrings;
  earlier: string;
  entries: readonly PrivateFingerprint[];
  has_text: boolean;
}): PrivateTextLeak | null {
  const { mode, entries } = input;
  if (!input.has_text) {
    return null;
  }
  const outgoing = [...input.strings.values, ...input.strings.scalars, ...input.strings.plumbing].map(scanForm);
  const text = [input.earlier, ...outgoing].join(' ');
  const known = new Set(entries.map(fingerprintKey));
  const lengthsOf = (kind: PrivateFingerprint['kind']): number[] => [
    ...new Set(entries.filter(entry => entry.kind === kind).map(entry => entry.length)),
  ];
  const copied = (kind: PrivateFingerprint['kind'], source: string): boolean => {
    for (const length of lengthsOf(kind)) {
      for (let start = 0; start + length <= source.length; start += 1) {
        const value = source.slice(start, start + length);
        if (known.has(fingerprintKey({ kind, length, digest: digestOf({ kind, value }) }))) {
          return true;
        }
      }
    }
    return false;
  };

  const address = compactForm(addressForm(text));
  if (copied('email', address)) {
    return 'contact';
  }
  const digits = digitsOf(text);
  if (copied('phone', digits)) {
    return 'contact';
  }
  if (copied('number', digits)) {
    return 'number';
  }
  // Whole words only: the words are compared as a run of whole words, so `Ann Lee` is not inside `Dann Leeds`.
  const words = wordsOf(text);
  for (const length of lengthsOf('name')) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const value = words.slice(start, start + length).join(' ');
      if (known.has(fingerprintKey({ kind: 'name', length, digest: digestOf({ kind: 'name', value }) }))) {
        return 'name';
      }
    }
  }
  if (mode === 'search' && copied('phrase', compactForm(text))) {
    return 'phrase';
  }
  for (const match of text.matchAll(ENCODED_TOKEN)) {
    if (isEncodedToken(match[0])) {
      return 'token';
    }
  }
  return null;
}

/**
 * The first kind of private content the outgoing strings carry, or null when they carry none. Checks whether a
 * search or map copies the mail or calendar text this chat read, by matching against fingerprints of that text.
 */
export function privateTextLeak(input: {
  mode: PrivateTextMode;
  strings: OutboundStrings;
  earlier: string;
  privateTexts: readonly string[];
}): PrivateTextLeak | null {
  return fingerprintLeak({
    mode: input.mode,
    strings: input.strings,
    earlier: input.earlier,
    entries: fingerprintsOf(input.privateTexts),
    has_text: input.privateTexts.length > 0,
  });
}
