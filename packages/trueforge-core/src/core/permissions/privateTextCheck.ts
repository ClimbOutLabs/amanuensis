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
/** The person's own name in their profile, whatever its case. */
const PROFILE_NAME = /<(?:user-name|address-user-as)>([^<\n\r]*)<\//gi;
/** The People line of recalled memory: `People: Name: what is known | Other Name: ...`. */
const PEOPLE_LINE = /^[ \t]*People:[ \t]*([^\n\r]*)/gim;
/** A calendar attendee's or organizer's display name in JSON. */
const DISPLAY_NAME = /"displayName"\s*:\s*"([^"]*)"/gi;
/** One recipient of a header list: quoted text (which may hold a comma) or the text up to the next comma. */
const RECIPIENT = /(?:"[^"]*"|[^,"])+/g;
/** An address written in words: `maria dot costa at harbour dot example`. */
const SPELLED_AT = /\s*\bat\b\s*/gi;
const SPELLED_DOT = /\s*\bdot\b\s*/gi;
/** Two to four capitalized words in a row, such as a person's full name written in running text. */
const CAPITALIZED_RUN = /\p{Lu}[\p{Ll}'’-]+(?:[ \t]+\p{Lu}[\p{Ll}'’-]+){1,3}/gu;
/** Capitalized words that open a sentence or a greeting rather than a name. */
const NOT_NAME_WORDS = new Set(
  (
    'a an the my our your his her their this that these those in on at to from for with and but or if when ' +
    'we i you he she they it dear hi hello mr mrs ms dr met call ask lunch dinner meeting ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july ' +
    'august september october november december'
  ).split(' '),
);
/** Street words, each with the short form a search may use instead. */
const STREET_WORDS: ReadonlyMap<string, string> = new Map([
  ['street', 'st'],
  ['road', 'rd'],
  ['avenue', 'ave'],
  ['lane', 'ln'],
  ['drive', 'dr'],
  ['boulevard', 'blvd'],
  ['court', 'ct'],
  ['place', 'pl'],
  ['square', 'sq'],
  ['terrace', 'tce'],
  ['way', 'way'],
  ['crescent', 'cres'],
]);
const STREET_WORD = [...STREET_WORDS].flatMap(([long, short]) => [long, short]).join('|');
/** A house number, one to three words of street name and a street word: `12 Harbour Street`. */
const STREET_ADDRESS = new RegExp(`\\b\\d{1,5}[A-Za-z]?\\s+(?:[\\p{L}'-]+\\s+){1,3}(?:${STREET_WORD})\\b`, 'giu');
/** Fewest letters and digits an address needs, so a short run such as `2 big st` is not kept as one. */
const MIN_STREET_ADDRESS_CHARS = 8;
/** A street word first and the house number after it: `Rua das Flores 12`. */
const STREET_ADDRESS_NUMBER_LAST =
  /\b(?:rua|calle|via|rue|avenida|strasse|straße)\s+(?:[\p{L}'-]+\s+){0,3}\d{1,5}\b/giu;
/**
 * Words that say a place is where the person lives or comes from, such as `lives in` or `City:`. What follows is a
 * town, region or country, which a search may name freely.
 */
const PLACE_CUE =
  /\b(?:(?:lives?|lived|living|based|located|resides?|residing|grew\s+up|raised|moved|relocated)\s+(?:in|to|near)|(?:home\s*town|city|town|region|state|province|county|country|location)\s*(?:is\s+|:\s*))\s*(?:the\s+)?/gi;
/**
 * A town, region or country: capitalized words. More places after commas, as in `Porto, Portugal`, count only when
 * the list ends the sentence, so a name after a comma (`Porto, Ana Reis is her sister`) is never read as a place.
 */
const PLACE_NAMES =
  /\p{Lu}[\p{L}'’-]*(?:[ \t]+\p{Lu}[\p{L}'’-]*){0,3}(?:(?:,[ \t]*\p{Lu}[\p{L}'’-]*(?:[ \t]+\p{Lu}[\p{L}'’-]*){0,3}){1,3}(?=[ \t]*(?:[.;)<\n\r]|$)))?/uy;
/** A code of letters and digits, such as an order, booking or account reference. */
const REFERENCE_CODE = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g;
const MIN_REFERENCE_CODE_CHARS = 6;
const MIN_REFERENCE_CODE_DIGITS = 3;
/** A date of birth's label; the date is read from the text right after it. */
const BIRTH_LABEL = /\b(?:born(?:\s+on)?|birthday(?:\s+is)?|date\s+of\s+birth|d\.?o\.?b\.?)\s*(?:is\s*)?[:-]?\s*/gi;
/** How far after its label a date of birth may start. */
const BIRTH_DATE_REACH = 40;
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTH_NAME =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ISO_DATE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
const NUMERIC_DATE = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g;
const DAY_MONTH_DATE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\.?,?\\s+(\\d{4})\\b`,
  'gi',
);
const MONTH_DAY_DATE = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');

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
 * `secret` is set once the chat read a secret or key file, which no grant lifts. `attached_files` counts the files
 * the person attached that the record covers, so a turn whose history shows more knows the record misses one. A
 * record saved before the count existed reads as covering none.
 */
export const ChatPrivateFingerprintsSchema = z.object({
  complete: z.boolean(),
  has_text: z.boolean(),
  secret: z.boolean(),
  entries: z.array(PrivateFingerprintSchema),
  attached_files: z.number().int().nonnegative().default(0),
});
export type ChatPrivateFingerprints = z.infer<typeof ChatPrivateFingerprintsSchema>;

/**
 * The record a save leaves: what was stored joined with what one turn saved. Once incomplete or holding a secret, a
 * chat stays so, and one turn's save never drops the fingerprints another turn saved.
 */
export function mergeChatPrivateFingerprints(input: {
  stored: ChatPrivateFingerprints | null;
  saved: ChatPrivateFingerprints;
}): ChatPrivateFingerprints {
  const { stored, saved } = input;
  if (stored === null) {
    return saved;
  }
  const entries = new Map(stored.entries.map(entry => [fingerprintKey(entry), entry]));
  for (const entry of saved.entries) {
    entries.set(fingerprintKey(entry), entry);
  }
  const fits = entries.size <= MAX_PRIVATE_FINGERPRINTS;
  return {
    complete: stored.complete && saved.complete && fits,
    has_text: stored.has_text || saved.has_text,
    secret: stored.secret || saved.secret,
    entries: fits ? [...entries.values()] : [],
    attached_files: Math.max(stored.attached_files, saved.attached_files),
  };
}

export function emptyChatPrivateFingerprints(): ChatPrivateFingerprints {
  // A chat with no private read yet has nothing it could miss, so it starts complete.
  return { complete: true, has_text: false, secret: false, entries: [], attached_files: 0 };
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
  const peopleLabels = [...text.matchAll(PEOPLE_LINE)].flatMap(line =>
    (line[1] ?? '').split(' | ').map(person => [person, person.split(':')[0] ?? '']),
  );
  for (const match of [...text.matchAll(DISPLAY_NAME), ...text.matchAll(PROFILE_NAME), ...peopleLabels]) {
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

/**
 * Escapes and character references a reader decodes into other letters: mail header encoded-words of any length,
 * quoted-printable escapes and soft line breaks, `\u` and `\x` escapes, numeric and named character references, and
 * short padded base64. Percent escapes are left out, since the fingerprints already read them decoded.
 */
const ENCODED_ESCAPE =
  /=\?[^?\s]+\?[BbQq]\?|=[0-9A-F]{2}|=\r?\n|\\u\{?[0-9A-Fa-f]{2,6}|\\x[0-9A-Fa-f]{2}|&#(?:[0-9]+|[xX][0-9A-Fa-f]+)|&[A-Za-z][A-Za-z0-9]{1,31};|(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?![A-Za-z0-9+/=])/;

/**
 * Whether the text holds any run written in an encoding, so the words a reader decodes from it are not its bytes and
 * fingerprints of it would miss them.
 */
export function hasEncodedText(text: string): boolean {
  if (ENCODED_ESCAPE.test(text)) {
    return true;
  }
  for (const match of text.matchAll(ENCODED_TOKEN)) {
    if (isEncodedToken(match[0])) {
      return true;
    }
  }
  return false;
}

function digestOf(input: { kind: PrivateFingerprint['kind']; value: string }): string {
  // Hashed with the kind, so a digit run and a phone number that read the same are told apart.
  return createHash('sha256').update(`${input.kind}\u0000${input.value}`).digest('hex').slice(0, 32);
}

function fingerprintKey(entry: PrivateFingerprint): string {
  return `${entry.kind}:${String(entry.length)}:${entry.digest}`;
}

/** Each date the text writes out, as eight digits, year first. A day and month that could be either order give both. */
function datesIn(text: string): string[] {
  const dates = new Set<string>();
  const add = ({ year, month, day }: { year: string; month: number; day: number }): void => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      dates.add(`${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`);
    }
  };
  const monthOf = (name: string): number => MONTHS.findIndex(month => month.startsWith(name.toLowerCase())) + 1;
  for (const [, year = '', month = '', day = ''] of text.matchAll(ISO_DATE)) {
    add({ year, month: Number(month), day: Number(day) });
  }
  for (const [, first = '', second = '', year = ''] of text.matchAll(NUMERIC_DATE)) {
    add({ year, month: Number(second), day: Number(first) });
    add({ year, month: Number(first), day: Number(second) });
  }
  for (const [, day = '', month = '', year = ''] of text.matchAll(DAY_MONTH_DATE)) {
    add({ year, month: monthOf(month), day: Number(day) });
  }
  for (const [, month = '', day = '', year = ''] of text.matchAll(MONTH_DAY_DATE)) {
    add({ year, month: monthOf(month), day: Number(day) });
  }
  return [...dates];
}

/** Dates of birth the text gives: a date written right after a label such as `born` or `date of birth`. */
function birthDatesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BIRTH_LABEL)) {
    const start = match.index + match[0].length;
    const after = text.slice(start, start + BIRTH_DATE_REACH);
    const first = [ISO_DATE, NUMERIC_DATE, DAY_MONTH_DATE, MONTH_DAY_DATE]
      .map(pattern => new RegExp(pattern.source, pattern.flags).exec(after))
      .filter(dated => dated !== null)
      .sort((left, right) => left.index - right.index)[0];
    if (first !== undefined) {
      found.push(...datesIn(first[0]));
    }
  }
  return found;
}

/**
 * Full names written in running text: two or more capitalized words, without a greeting or weekday before them, and
 * not a street's name.
 */
function runningTextNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(CAPITALIZED_RUN)) {
    const words = match[0].split(/[ \t]+/);
    const first = words.findIndex(word => !NOT_NAME_WORDS.has(word.toLowerCase()));
    const kept = first < 0 ? [] : words.slice(first);
    // A street's name is part of an address, which a map may use; the address check keeps it for searches.
    const last = (kept[kept.length - 1] ?? '').toLowerCase();
    if (STREET_WORDS.has(last) || [...STREET_WORDS.values()].includes(last)) {
      continue;
    }
    if (kept.length >= MIN_NAME_WORDS && compactForm(kept.join('')).length >= MIN_NAME_CHARS) {
      names.push(kept.join(' '));
    }
  }
  return names;
}

/**
 * The text with each town, region or country it names as where the person lives blanked out, so those words are not
 * kept as a name. The words after a street address and its comma are the town of that address. Street addresses,
 * postal codes and numbers are read from the whole text, so they stay private.
 */
function withoutPlaces(text: string): string {
  const starts = [...text.matchAll(PLACE_CUE)].map(match => match.index + match[0].length);
  for (const match of text.matchAll(STREET_ADDRESS)) {
    const comma = /^,[ \t]*/.exec(text.slice(match.index + match[0].length));
    if (comma !== null) {
      starts.push(match.index + match[0].length + comma[0].length);
    }
  }
  let blanked = text;
  for (const start of starts) {
    PLACE_NAMES.lastIndex = start;
    const place = PLACE_NAMES.exec(text);
    if (place !== null) {
      blanked = blanked.slice(0, start) + ' '.repeat(place[0].length) + blanked.slice(start + place[0].length);
    }
  }
  return blanked;
}

/**
 * A name and the shorter forms a search may write it in: with three or more words, each two words in a row and the
 * first with the last, so `Dr Rafe Ollerenshaw` and `Ana Maria Reis` are found as `Rafe Ollerenshaw` and `Ana Reis`.
 */
function nameForms(name: string): string[] {
  const words = name.split(/\s+/).filter(word => word !== '');
  if (words.length < 3) {
    return [name];
  }
  const pairs = words.slice(1).map((word, index) => `${words[index] ?? ''} ${word}`);
  return [name, ...pairs, `${words[0] ?? ''} ${words[words.length - 1] ?? ''}`];
}

/** Street addresses as spaced words, each also with its street word in the other of its long and short forms. */
function streetAddressesIn(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [STREET_ADDRESS, STREET_ADDRESS_NUMBER_LAST]) {
    for (const match of text.matchAll(pattern)) {
      const words = wordsOf(match[0]);
      if (words.join('').length < MIN_STREET_ADDRESS_CHARS) {
        continue;
      }
      found.push(words.join(' '));
      const swapped = words.map(word => {
        const short = STREET_WORDS.get(word);
        const long = [...STREET_WORDS].find(([, abbreviation]) => abbreviation === word)?.[0];
        return short ?? long ?? word;
      });
      found.push(swapped.join(' '));
    }
  }
  return found;
}

/** Codes of letters and digits, such as an order or account reference, as written. */
function referenceCodesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REFERENCE_CODE)) {
    const code = compactForm(match[0]);
    const digits = digitsOf(code).length;
    if (code.length >= MIN_REFERENCE_CODE_CHARS && digits >= MIN_REFERENCE_CODE_DIGITS && digits < code.length) {
      found.push(match[0]);
    }
  }
  return found;
}

/**
 * Fingerprints of the private texts, each folded the same way the outgoing text is, so a copy matches however
 * it was written. A header name is kept both spaced and run together, since either can appear in the outgoing
 * text. Names from running text and reference codes are kept the same way, so each is matched only as whole words.
 * Street addresses are kept as spaced phrases, matched at word edges, so only a search checks them: a map may name
 * an address the private text gives. `word_runs` also keeps every
 * run of copied words; a source the host adds to every reply leaves it off, since its ordinary wording would
 * hold ordinary searches.
 */
export function fingerprintsOf(input: {
  texts: readonly string[];
  word_runs: boolean;
  /**
   * Whether names, codes and addresses written in running text are kept too. Only for a text that is the person's
   * own (a read of their mail, calendar or spaces, their memory, profile or files): a web page's names are not.
   */
  running_details: boolean;
  /**
   * Whether the town, region or country the text gives as where the person lives is public. Only for the person's
   * profile: a search for the weather in their own town carries nothing private.
   */
  public_places: boolean;
}): PrivateFingerprint[] {
  const found = new Map<string, PrivateFingerprint>();
  const add = (kind: PrivateFingerprint['kind'], length: number, value: string): void => {
    const entry = { kind, length, digest: digestOf({ kind, value }) };
    found.set(fingerprintKey(entry), entry);
  };
  for (const raw of input.texts) {
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
    for (const date of birthDatesIn(text)) {
      add('number', date.length, date);
    }
    const running = input.running_details;
    const runningText = input.public_places ? withoutPlaces(text) : text;
    const names = [...namesIn(text), ...(running ? runningTextNames(runningText) : [])].flatMap(nameForms);
    for (const name of [...names, ...(running ? referenceCodesIn(text) : [])]) {
      const words = wordsOf(name);
      if (compactForm(name).length >= MIN_NAME_CHARS) {
        add('name', words.length, words.join(' '));
        add('name', 1, words.join(''));
      }
    }
    for (const address of running ? streetAddressesIn(text) : []) {
      add('phrase', address.length, address);
    }
    if (input.word_runs) {
      for (const run of wordRunsCompact(text, COPIED_WORDS)) {
        if (run.length >= MIN_PHRASE_CHARS) {
          add('phrase', run.length, run);
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * Adds the fingerprints of one more private text to a chat's kept state. Returns false, and keeps nothing more,
 * once the chat is over its cap, so the caller can mark the state lost.
 */
export function addPrivateFingerprints(input: {
  state: ChatPrivateFingerprints;
  text: string;
  word_runs: boolean;
  running_details: boolean;
  public_places: boolean;
}): boolean {
  const merged = new Map(input.state.entries.map(entry => [fingerprintKey(entry), entry]));
  const { text, word_runs, running_details, public_places } = input;
  for (const entry of fingerprintsOf({ texts: [text], word_runs, running_details, public_places })) {
    merged.set(fingerprintKey(entry), entry);
  }
  if (merged.size > MAX_PRIVATE_FINGERPRINTS) {
    return false;
  }
  input.state.entries = [...merged.values()];
  input.state.has_text = true;
  return true;
}

/** Longest run of the person's words kept for the check, as long as the longest name or code a fingerprint holds. */
const MAX_PERSON_RUN_WORDS = 6;

/**
 * Whether a matched value is one the person wrote in this turn's own message, read as whole words or whole numbers.
 * They chose to share it, so it is never a leak. Only the host's record of their message is read here.
 */
function personWroteCheck(personText: string): (kind: PrivateFingerprint['kind'], value: string) => boolean {
  if (personText.trim() === '') {
    return () => false;
  }
  const text = scanForm(personText);
  const words = wordsOf(text);
  const spaced = ` ${words.join(' ')} `;
  const runs = new Set<string>();
  for (let size = 1; size <= MAX_PERSON_RUN_WORDS; size += 1) {
    for (const run of wordRunsCompact(text, size)) {
      runs.add(run);
    }
  }
  const emails = new Set([...addressForm(text).matchAll(EMAIL)].map(match => compactForm(match[0])));
  const numbers = new Set([
    ...[...text.matchAll(PHONE_CANDIDATE)].map(match => digitsOf(match[0])),
    ...[...text.matchAll(DIGIT_RUN)].map(match => match[0]),
    ...datesIn(text),
  ]);
  return (kind, value) => {
    switch (kind) {
      case 'email':
        return emails.has(value);
      case 'phone':
      case 'number':
        return numbers.has(value);
      case 'name':
      case 'phrase':
        // A spaced value is matched as whole words; a compact one as a run of words written together.
        return value.includes(' ') ? spaced.includes(` ${value} `) : runs.has(value);
    }
  };
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
  /**
   * Whether a long encoded run counts. The private-read checks count one; the check every search gets leaves it to
   * the outbound guard, whose own rule knows a link's path and a provider's plumbing.
   */
  encoded_runs: boolean;
  /** The text of this turn's own message from the person. What they wrote there is never a leak. */
  person_text: string;
}): PrivateTextLeak | null {
  const { mode, entries } = input;
  if (!input.has_text) {
    return null;
  }
  const personWrote = personWroteCheck(input.person_text);
  // Keys go out with the call too, so a detail the model puts in an argument's name is read like its value.
  const outgoing = [
    ...input.strings.values,
    ...input.strings.scalars,
    ...input.strings.plumbing,
    ...input.strings.keys,
  ].map(scanForm);
  const text = [input.earlier, ...outgoing].join(' ');
  const known = new Set(entries.map(fingerprintKey));
  const lengthsOf = (kind: PrivateFingerprint['kind']): number[] => [
    ...new Set(entries.filter(entry => entry.kind === kind).map(entry => entry.length)),
  ];
  // A street address is kept spaced, so it matches only where whole words begin and end: never inside a longer word.
  const spacedPhraseCopied = (words: readonly string[]): boolean => {
    const spaced = words.join(' ');
    const starts: number[] = [];
    let offset = 0;
    for (const word of words) {
      starts.push(offset);
      offset += word.length + 1;
    }
    for (const length of lengthsOf('phrase')) {
      for (const start of starts) {
        const end = start + length;
        if (end > spaced.length || (end < spaced.length && spaced[end] !== ' ')) {
          continue;
        }
        const value = spaced.slice(start, end);
        if (
          known.has(fingerprintKey({ kind: 'phrase', length, digest: digestOf({ kind: 'phrase', value }) })) &&
          !personWrote('phrase', value)
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const copied = (kind: PrivateFingerprint['kind'], source: string): boolean => {
    for (const length of lengthsOf(kind)) {
      for (let start = 0; start + length <= source.length; start += 1) {
        const value = source.slice(start, start + length);
        if (
          known.has(fingerprintKey({ kind, length, digest: digestOf({ kind, value }) })) &&
          !personWrote(kind, value)
        ) {
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
  if (copied('number', digits) || datesIn(text).some(date => copied('number', date))) {
    return 'number';
  }
  // Whole words only: the words are compared as a run of whole words, so `Ann Lee` is not inside `Dann Leeds`.
  const words = wordsOf(text);
  for (const length of lengthsOf('name')) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const value = words.slice(start, start + length).join(' ');
      if (
        known.has(fingerprintKey({ kind: 'name', length, digest: digestOf({ kind: 'name', value }) })) &&
        !personWrote('name', value)
      ) {
        return 'name';
      }
    }
  }
  if (mode === 'search' && (copied('phrase', compactForm(text)) || spacedPhraseCopied(words))) {
    return 'phrase';
  }
  if (!input.encoded_runs) {
    return null;
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
  person_text: string;
}): PrivateTextLeak | null {
  return fingerprintLeak({
    mode: input.mode,
    strings: input.strings,
    earlier: input.earlier,
    person_text: input.person_text,
    // These texts also hold other results kept after a private read, such as web pages, so only what main
    // fingerprinted is taken here; the chat's kept fingerprints carry the running-text details of the reads.
    entries: fingerprintsOf({
      texts: input.privateTexts,
      word_runs: true,
      running_details: false,
      public_places: false,
    }),
    has_text: input.privateTexts.length > 0,
    encoded_runs: true,
  });
}
