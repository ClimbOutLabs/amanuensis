import type { OutboundStrings } from './outboundGuard';

export type PrivateTextMode = 'search' | 'maps';

/** What the outgoing text carries from the private text: the first kind found. */
export type PrivateTextLeak = 'contact' | 'number' | 'name' | 'phrase' | 'token';

/** Five words in a row copied from the private text is a phrase; four is not. */
const COPIED_WORDS = 5;
/** Fewest digits a phone number has, when written with a leading plus sign. */
const MIN_INTERNATIONAL_PHONE_DIGITS = 8;
/** Fewest digits a phone number has when written without one. Shorter runs are postal codes and dates. */
const MIN_PHONE_DIGITS = 10;
/** Shortest name part worth matching on its own, so a short common word never trips the check. */
const MIN_NAME_PART_CHARS = 4;
const MIN_NAME_CHARS = 3;
const MIN_ENCODED_TOKEN_CHARS = 20;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu;
/** A run of six or more digits, such as an order or booking number. */
const DIGIT_RUN = /\d{6,}/g;
const PHONE_CANDIDATE = /\+?\d(?:[\s().-]?\d){6,}/g;
const WORD = /[\p{L}\p{N}]+/gu;
const ENCODED_TOKEN = /[A-Za-z0-9+/]{20,}={0,2}/g;
/** A header such as `From: Name <address>`, or the same field in JSON: `"from": "Name <address>"`. */
const NAMED_HEADER = /"?\b(?:from|to|cc|bcc|organizer)"?\s*[:=]\s*"?([^\n\r"]*)/gi;
const DISPLAY_NAME = /"displayName"\s*:\s*"([^"]*)"/gi;

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/** Names of the people a mail header or calendar attendee list names, with any address removed. */
function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(NAMED_HEADER)) {
    for (const entry of (match[1] ?? '').split(',')) {
      const angle = entry.indexOf('<');
      const name = (angle < 0 ? entry : entry.slice(0, angle)).replace(/^[\s"']+|[\s"']+$/g, '');
      if (name.length >= MIN_NAME_CHARS && !name.includes('@')) {
        names.push(name);
      }
    }
  }
  for (const match of text.matchAll(DISPLAY_NAME)) {
    const name = (match[1] ?? '').trim();
    if (name.length >= MIN_NAME_CHARS) {
      names.push(name);
    }
  }
  return names;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** Every run of `size` words in the text, joined by single spaces. */
function wordRuns(text: string, size: number): string[] {
  const words = wordsOf(text);
  const runs: string[] = [];
  for (let start = 0; start + size <= words.length; start += 1) {
    runs.push(words.slice(start, start + size).join(' '));
  }
  return runs;
}

/**
 * The first kind of private content the outgoing strings carry, or null when they carry none. Checks
 * whether a search or map copies the mail or calendar text this chat read. A map may name a street
 * address from it, since routing there is the point; a search may not copy phrases or names.
 */
export function privateTextLeak(input: {
  mode: PrivateTextMode;
  strings: OutboundStrings;
  privateTexts: readonly string[];
}): PrivateTextLeak | null {
  const { mode, privateTexts } = input;
  const outgoing = [...input.strings.values, ...input.strings.scalars, ...input.strings.plumbing];
  if (privateTexts.length === 0) {
    return null;
  }
  const emails = new Set<string>();
  const phoneDigits = new Set<string>();
  const numbers = new Set<string>();
  const names = new Set<string>();
  const phrases = new Set<string>();
  for (const text of privateTexts) {
    for (const match of text.matchAll(EMAIL)) {
      emails.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(PHONE_CANDIDATE)) {
      const digits = digitsOf(match[0]);
      const international = match[0].startsWith('+') && digits.length >= MIN_INTERNATIONAL_PHONE_DIGITS;
      if (international || digits.length >= MIN_PHONE_DIGITS) {
        phoneDigits.add(digits);
      }
    }
    for (const match of text.matchAll(DIGIT_RUN)) {
      numbers.add(match[0]);
    }
    for (const name of namesIn(text)) {
      names.add(normalized(name));
      for (const part of wordsOf(name)) {
        if (part.length >= MIN_NAME_PART_CHARS) {
          names.add(part);
        }
      }
    }
    if (mode === 'search') {
      for (const run of wordRuns(text, COPIED_WORDS)) {
        phrases.add(run);
      }
    }
  }

  for (const value of outgoing) {
    const lower = value.toLowerCase();
    const flat = normalized(value);
    const digits = digitsOf(value);
    for (const email of emails) {
      if (lower.includes(email)) {
        return 'contact';
      }
    }
    for (const phone of phoneDigits) {
      if (digits.includes(phone)) {
        return 'contact';
      }
    }
    for (const run of numbers) {
      if (value.includes(run)) {
        return 'number';
      }
    }
    for (const name of names) {
      if (flat.includes(name)) {
        return 'name';
      }
    }
    if (mode === 'search') {
      for (const run of wordRuns(value, COPIED_WORDS)) {
        if (phrases.has(run)) {
          return 'phrase';
        }
      }
    }
    for (const match of value.matchAll(ENCODED_TOKEN)) {
      if (match[0].length >= MIN_ENCODED_TOKEN_CHARS && /\d/.test(match[0])) {
        return 'token';
      }
    }
  }
  return null;
}
