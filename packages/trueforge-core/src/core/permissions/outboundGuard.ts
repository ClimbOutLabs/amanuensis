/**
 * Outbound secret guard: the canonical, deterministic check the host runs over every string a tool
 * call would send off this machine. No model judgment and no network; the same arguments always
 * give the same verdict. Search uses it first; maps and URL fetch are meant to reuse it.
 *
 * It is a tripwire for accidental or injected leaks, not a proof of absence: text is normalized,
 * percent-decoded once, and read together with the turn's earlier searches, but a secret the model
 * encodes some other way past every rule below is outside what a deterministic scan can see.
 */

import { SERVER_SECRET_REASON } from './searchHoldText.js';

/** Most characters one string of the arguments (a query, an objective) may carry in a silent call. */
export const OUTBOUND_MAX_CHARS = 200;

/** Most characters all of a call's strings together may carry, so many short fields cannot add up to a bulk send. */
export const OUTBOUND_MAX_TOTAL_CHARS = 1000;

/**
 * Most characters a provider plumbing value (a session id, a model name) may carry and still skip the
 * encoded-run rule. The model fills these fields itself, so the cap bounds what they can carry out.
 */
export const OUTBOUND_MAX_PLUMBING_CHARS = 40;

/** The characters of an identifier. A plumbing value with anything else is read as user text. */
const PLUMBING_IDENTIFIER = /^[A-Za-z0-9._:+/=-]+$/;

function isPlumbingIdentifier(value: string): boolean {
  return value.length <= OUTBOUND_MAX_PLUMBING_CHARS && PLUMBING_IDENTIFIER.test(value);
}

/** Server-held secrets shorter than this are not matched: they would flag ordinary words. */
export const OUTBOUND_MIN_SECRET_LENGTH = 8;

const MAX_DEPTH = 6;
const MAX_STRINGS = 64;

export const OUTBOUND_GUARD_RULES = [
  'server_secret',
  'private_key',
  'jwt',
  'key_prefix',
  'encoded_run',
  'password_label',
  'card_number',
  'too_long',
  'uninspectable',
] as const;
export type OutboundGuardRule = (typeof OUTBOUND_GUARD_RULES)[number];

export type OutboundGuardVerdict = { ok: true } | { ok: false; rule: OutboundGuardRule };

/** Every piece of text the arguments carry, kept apart by where it sat. */
export interface OutboundStrings {
  /** String values: what a person would call the query. */
  values: string[];
  /** Numbers and booleans as text: a card number can be sent as a JSON number. */
  scalars: string[];
  /** Object keys. */
  keys: string[];
  /** Values of the provider plumbing fields the catalog declares: scanned for secrets, but not user content. */
  plumbing: string[];
}

/**
 * Collects the text in tool arguments. Undefined when the structure is too deep or too wide to
 * inspect, which the guard treats as a trip rather than letting it through unread. A plain string,
 * number or boolean in a top-level field named in `plumbingFields` is kept apart from the user's text.
 */
export function collectOutboundStrings(
  value: unknown,
  plumbingFields: readonly string[] = [],
): OutboundStrings | undefined {
  const found: OutboundStrings = { values: [], scalars: [], keys: [], plumbing: [] };
  const visit = (node: unknown, depth: number): boolean => {
    if (
      depth > MAX_DEPTH ||
      found.values.length + found.scalars.length + found.keys.length + found.plumbing.length > MAX_STRINGS
    ) {
      return false;
    }
    if (typeof node === 'string') {
      found.values.push(node);
      return true;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      found.scalars.push(String(node));
      return true;
    }
    if (node === null || node === undefined) {
      return true;
    }
    if (Array.isArray(node)) {
      return node.every(item => visit(item, depth + 1));
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        found.keys.push(key);
        if (
          depth === 0 &&
          plumbingFields.includes(key) &&
          (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')
        ) {
          found.plumbing.push(String(child));
          continue;
        }
        if (!visit(child, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    return false;
  };
  return visit(value, 0) ? found : undefined;
}

/** Cyrillic and Greek letters that read as Latin ones; NFKC leaves them apart. A small table, not a full confusables map. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0445': 'x',
  '\u0443': 'y',
  '\u0456': 'i',
  '\u0455': 's',
  '\u03BF': 'o',
  '\u03C1': 'p',
  '\u03BD': 'v',
  '\u0410': 'A',
  '\u0412': 'B',
  '\u0415': 'E',
  '\u041A': 'K',
  '\u041C': 'M',
  '\u041D': 'H',
  '\u041E': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0422': 'T',
  '\u0425': 'X',
  '\u0391': 'A',
  '\u0392': 'B',
  '\u0395': 'E',
  '\u0397': 'H',
  '\u0399': 'I',
  '\u039A': 'K',
  '\u039C': 'M',
  '\u039D': 'N',
  '\u039F': 'O',
  '\u03A1': 'P',
  '\u03A4': 'T',
  '\u03A7': 'X',
};
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/**
 * Folds the spellings a tripwire would otherwise miss: look-alike forms (full-width digits,
 * ligatures), combining marks, format characters (zero-width joiners, bidi controls, tag characters)
 * that split a token invisibly, and a few look-alike letters.
 */
function normalizeForScan(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(CONFUSABLE_CHARS, char => CONFUSABLES[char] ?? char);
}

/** Percent-escapes decoded once; an escape that does not decode (a stray `%`) stays as written. */
function decodeOnce(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** A URL without its scheme and host, so a secret split between a query and a link reads as one run. */
function withoutUrlOrigin(text: string): string {
  return text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*\/?/, '');
}

/** Letters and digits only, lower-cased: spacing, punctuation and case cannot hide a secret. */
function compactForm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const PRIVATE_KEY_BLOCK = /-{3,}\s*BEGIN[\sA-Z0-9]*PRIVATE\s+KEY/i;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;

/** Provider key shapes. Each needs enough body that an ordinary hyphenated word cannot match. */
const KEY_PREFIXES: readonly RegExp[] = [
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // Anthropic.
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  // OpenAI and compatible: the digit requirement keeps `sk-learn-...` style words out.
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/,
  // Slack.
  /\bxox[abprso]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  // Nebius IAM and Token Factory keys, by an assumed `v1.` shape: no setting or provider code in this
  // repository fixes the format, so an exact match on the configured key is what really covers it.
  /\bv1\.[A-Za-z0-9_-]{30,}/,
  // Google, Stripe, Hugging Face, npm, GitLab, SendGrid, Twilio.
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\bSK[0-9a-f]{32}\b/,
  // An Authorization header value pasted whole.
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
];

/** A password label, its delimiter, then a value. A bare mention of "password" does not match. */
const PASSWORD_LABEL = /\b(?:pass(?:word|wd|code|phrase)|pwd)s?["']?\s*[:=]\s*["'`]?[^\s"'`]{3,}/i;
/** `passcode 123456`: the label may take its value after a space when the value contains a digit. */
const PASSCODE_THEN_DIGITS = /\bpass(?:code|phrase)\s+["'`]?\S*\d\S*/i;
/**
 * Other credential labels need a longer value with a digit in it, so `api key: 2024 changes` and
 * `token: the movie` pass while `token=ab12cd34ef` does not.
 */
const CREDENTIAL_LABEL =
  /\b(?:secret|token|api[\s_-]?key|access[\s_-]?key|auth(?:orization)?)s?["']?\s*[:=]\s*["'`]?(?=[^\s"'`]*\d)[^\s"'`]{8,}/i;

/** Digit and symbol stand-ins for letters (`passw0rd`, `p@ssword`), undone before the label rules run. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

function unLeet(text: string): string {
  return text.replace(/[013457@$]/g, char => LEET[char] ?? char);
}

function hasCredentialLabel(text: string): boolean {
  return [text, unLeet(text)].some(
    candidate =>
      PASSWORD_LABEL.test(candidate) || PASSCODE_THEN_DIGITS.test(candidate) || CREDENTIAL_LABEL.test(candidate),
  );
}

const HEX_RUN = /[0-9A-Fa-f]{20,}/;
const BASE64_RUN = /[A-Za-z0-9+/_=-]{20,}/g;
/** Longest piece of a path-like run (`src/components/Button/index`) that still reads as ordinary text. */
const MAX_PATH_SEGMENT = 12;

function lowerToUpperTransitions(word: string): number {
  let count = 0;
  for (let i = 1; i < word.length; i += 1) {
    if (/[a-z]/.test(word.charAt(i - 1)) && /[A-Z]/.test(word.charAt(i))) {
      count += 1;
    }
  }
  return count;
}

/** A long run of letters only: a word or an identifier (`internationalization`, `IllegalArgumentException`). */
function looksLikeWord(run: string): boolean {
  return /^[A-Za-z]+$/.test(run) && lowerToUpperTransitions(run) <= Math.floor(run.length / 6);
}

function isEncodedRun(text: string): boolean {
  if (HEX_RUN.test(text)) {
    return true;
  }
  for (const match of text.matchAll(BASE64_RUN)) {
    const run = match[0];
    if (run.includes('+') || run.includes('=')) {
      return true;
    }
    const segments = run.split(/[/_-]/).filter(segment => segment.length > 0);
    if (segments.some(segment => segment.length > MAX_PATH_SEGMENT && !looksLikeWord(segment))) {
      return true;
    }
  }
  return false;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits.charAt(i));
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Card-shaped digit groups only: a bare 13-19 digit run, or the 4-4-4-n and 4-6-5 groupings with a
 * space, dot or dash. Dates, date ranges and phone numbers do not have those shapes. A candidate must also
 * lead with a card network digit (2 to 6) and pass Luhn.
 */
const CARD_CANDIDATES: readonly RegExp[] = [
  /(?<!\d)\d{13,19}(?!\d)/g,
  /(?<!\d)\d{4}[ .-]\d{4}[ .-]\d{4}[ .-]\d{1,7}(?!\d)/g,
  /(?<!\d)\d{4}[ .-]\d{6}[ .-]\d{5}(?!\d)/g,
];

function hasCardNumber(text: string): boolean {
  for (const pattern of CARD_CANDIDATES) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/[ .-]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && passesLuhn(digits)) {
        return true;
      }
    }
  }
  return false;
}

/** Spellings of a secret a query could carry: as stored, URL-escaped, base64 (both alphabets) and hex. */
function secretSpellings(secret: string): string[] {
  const normalized = normalizeForScan(secret);
  const bytes = Buffer.from(normalized, 'utf8');
  return [
    normalized,
    encodeURIComponent(normalized),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
  ];
}

/**
 * Compared in compact form, so spacing, punctuation and case cannot hide a secret. A secret shorter
 * than {@link OUTBOUND_MIN_SECRET_LENGTH} is skipped: real keys and tokens are far longer, and a
 * short value would flag ordinary words.
 */
function containsServerSecret(input: { texts: readonly string[]; secrets: readonly string[] }): boolean {
  const haystacks = input.texts.map(compactForm);
  for (const secret of input.secrets) {
    if (normalizeForScan(secret).length < OUTBOUND_MIN_SECRET_LENGTH) {
      continue;
    }
    for (const spelling of secretSpellings(secret)) {
      const needle = compactForm(spelling);
      if (needle.length >= OUTBOUND_MIN_SECRET_LENGTH && haystacks.some(haystack => haystack.includes(needle))) {
        return true;
      }
    }
  }
  return false;
}

const SECRET_MASK = '••••••';
/** A secret at least this long keeps its first and last two characters on screen; a shorter one shows none. */
const MASK_REVEAL_MIN_LENGTH = 12;

function maskSecretText(text: string): string {
  return text.length >= MASK_REVEAL_MIN_LENGTH ? `${text.slice(0, 2)}${SECRET_MASK}${text.slice(-2)}` : SECRET_MASK;
}

/**
 * Copy of tool arguments with every written-out spelling of a server-held secret masked, for text a
 * user sees. Undefined when the secret is not found as written (split across values or calls, or
 * hidden by spacing), so the caller hides the whole text instead of guessing which part to keep.
 * `plumbingFields` must match the scan that found the secret, so values are glued in the same order.
 */
export function maskServerSecrets(input: {
  params: Record<string, unknown>;
  secrets: readonly string[];
  earlier?: string | undefined;
  plumbingFields?: readonly string[] | undefined;
}): Record<string, unknown> | undefined {
  const spellings = input.secrets
    .filter(secret => normalizeForScan(secret).length >= OUTBOUND_MIN_SECRET_LENGTH)
    .flatMap(secretSpellings)
    .filter(spelling => spelling !== '')
    .sort((a, b) => b.length - a.length);
  const maskString = (text: string): string =>
    spellings.reduce((masked, spelling) => masked.split(spelling).join(maskSecretText(spelling)), text);
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return maskString(node);
    }
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [maskString(key), visit(child)]));
    }
    return node;
  };
  const masked = visit(input.params);
  const strings = collectOutboundStrings(masked, input.plumbingFields);
  if (!isRecord(masked) || strings === undefined) {
    return undefined;
  }
  const verdict = checkOutboundStrings({ strings, secrets: input.secrets, earlier: input.earlier });
  return !verdict.ok && verdict.rule === 'server_secret' ? undefined : masked;
}

/** Most characters of earlier outbound text kept to catch a secret sent in pieces across calls. */
export const OUTBOUND_EARLIER_MAX_CHARS = 1024;

/** User text first, then plumbing values, so `userCount` splits the two. */
function scannedValues(strings: OutboundStrings): { raw: string[]; decoded: string[]; userCount: number } {
  const raw = [...strings.values, ...strings.scalars, ...strings.plumbing].map(normalizeForScan);
  return { raw, decoded: raw.map(decodeOnce), userCount: strings.values.length + strings.scalars.length };
}

/**
 * The normalized text of one call, to be remembered and passed back as `earlier` on the next call
 * so a secret split over two searches is still seen whole.
 */
export function outboundTrace(strings: OutboundStrings): string {
  return scannedValues(strings).decoded.join('');
}

/** Appends a call's text to the remembered tail, keeping only the most recent characters. */
export function appendOutboundTrace(input: { earlier: string; strings: OutboundStrings }): string {
  return (input.earlier + outboundTrace(input.strings)).slice(-OUTBOUND_EARLIER_MAX_CHARS);
}

/**
 * Checks the strings of one outbound call. `secrets` are the exact values the server holds
 * (provider keys, OAuth tokens and client secrets, the API key, other configured secrets); a query
 * containing one is blocked. `earlier` is the text of the calls that already went out this turn
 * without asking: a secret that straddles the boundary is still seen. Everything else is pattern
 * based. Text is normalized and percent-decoded once before the rules run; the original spelling is
 * scanned as well. A short identifier-shaped plumbing value skips the encoded-run rule only.
 */
export function checkOutboundStrings(input: {
  strings: OutboundStrings;
  secrets: readonly string[];
  earlier?: string | undefined;
}): OutboundGuardVerdict {
  const { raw, decoded, userCount } = scannedValues(input.strings);
  const keys = input.strings.keys.map(normalizeForScan);
  const keyTexts = [...keys, ...keys.map(decodeOnce)];
  const text = [...raw, ...decoded, ...keyTexts].join('\n');
  // A plumbing value shaped like a short identifier (a session id) is expected to look random, so only
  // the encoded-run rule skips it. The model writes these fields, so a longer value, or one with
  // anything but identifier characters, is scanned like user text.
  const isExempt = (index: number): boolean => index >= userCount && isPlumbingIdentifier(raw[index] ?? '');
  const encodedScan = [
    ...raw.filter((_, index) => !isExempt(index)),
    ...decoded.filter((_, index) => !isExempt(index)),
    ...keyTexts,
  ].join('\n');
  // Adjacent values glued together, on either side of the earlier calls' text: a key split across
  // array items or across searches shows its prefix, whichever of the parallel calls was read first.
  const earlier = input.earlier ?? '';
  const joined = [raw.join(''), decoded.join(''), decoded.map(withoutUrlOrigin).join('')];
  const glued = joined.flatMap(candidate => [earlier + candidate, candidate + earlier]);

  if (containsServerSecret({ texts: [text, ...glued], secrets: input.secrets })) {
    return { ok: false, rule: 'server_secret' };
  }
  if (PRIVATE_KEY_BLOCK.test(text) || glued.some(candidate => PRIVATE_KEY_BLOCK.test(candidate))) {
    return { ok: false, rule: 'private_key' };
  }
  if (JWT.test(text) || glued.some(candidate => JWT.test(candidate))) {
    return { ok: false, rule: 'jwt' };
  }
  if (KEY_PREFIXES.some(pattern => pattern.test(text) || glued.some(candidate => pattern.test(candidate)))) {
    return { ok: false, rule: 'key_prefix' };
  }
  if (isEncodedRun(encodedScan)) {
    return { ok: false, rule: 'encoded_run' };
  }
  if (hasCredentialLabel(text)) {
    return { ok: false, rule: 'password_label' };
  }
  if (hasCardNumber(text)) {
    return { ok: false, rule: 'card_number' };
  }
  const userText = raw.slice(0, userCount);
  if (
    userText.some(value => value.length > OUTBOUND_MAX_CHARS) ||
    userText.reduce((total, value) => total + value.length, 0) > OUTBOUND_MAX_TOTAL_CHARS ||
    raw.slice(userCount).some(value => value.length > OUTBOUND_MAX_PLUMBING_CHARS)
  ) {
    return { ok: false, rule: 'too_long' };
  }
  return { ok: true };
}

/** Plain-language reason for a rule, for approval cards and audit rows. Never includes the text itself. */
export function describeOutboundRule(rule: OutboundGuardRule): string {
  switch (rule) {
    case 'server_secret':
      return SERVER_SECRET_REASON;
    case 'private_key':
      return 'it contains a private key';
    case 'jwt':
      return 'it contains a signed token';
    case 'key_prefix':
      return 'it contains what looks like an API key';
    case 'encoded_run':
      return 'it contains a long encoded string';
    case 'password_label':
      return 'it contains a password';
    case 'card_number':
      return 'it contains a payment card number';
    case 'too_long':
      return `it is longer than a search may be without asking: ${String(OUTBOUND_MAX_CHARS)} characters in one part, ${String(OUTBOUND_MAX_TOTAL_CHARS)} in all, or ${String(OUTBOUND_MAX_PLUMBING_CHARS)} in a provider's own detail`;
    case 'uninspectable':
      return 'its arguments are too large to inspect';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
