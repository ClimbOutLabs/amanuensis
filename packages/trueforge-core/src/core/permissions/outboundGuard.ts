/**
 * Outbound secret guard: the canonical, deterministic check the host runs over every string a tool
 * call would send off this machine. No model judgment and no network; the same arguments always
 * give the same verdict. Search uses it first; maps and URL fetch are meant to reuse it.
 *
 * It is a tripwire for accidental or injected leaks, not a proof of absence: a secret the model
 * re-encodes, or splits across separate arguments, past every rule below is outside what a
 * deterministic scan can see.
 */

/** Most characters of text, summed over every string in the arguments, a silent call may carry. */
export const OUTBOUND_MAX_CHARS = 200;

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
}

/**
 * Collects the text in tool arguments. Undefined when the structure is too deep or too wide to
 * inspect, which the guard treats as a trip rather than letting it through unread.
 */
export function collectOutboundStrings(value: unknown): OutboundStrings | undefined {
  const found: OutboundStrings = { values: [], scalars: [], keys: [] };
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || found.values.length + found.scalars.length + found.keys.length > MAX_STRINGS) {
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

/** NFKC folds look-alike forms (full-width digits, ligatures); invisible joiners cannot split a token. */
function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '');
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
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
  // Nebius IAM and Token Factory keys.
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
 * space or dash. Dates, date ranges and phone numbers do not have those shapes. A candidate must also
 * lead with a card network digit (2 to 6) and pass Luhn.
 */
const CARD_CANDIDATES: readonly RegExp[] = [
  /(?<!\d)\d{13,19}(?!\d)/g,
  /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}(?!\d)/g,
  /(?<!\d)\d{4}[ -]\d{6}[ -]\d{5}(?!\d)/g,
];

function hasCardNumber(text: string): boolean {
  for (const pattern of CARD_CANDIDATES) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && passesLuhn(digits)) {
        return true;
      }
    }
  }
  return false;
}

function containsServerSecret(input: { text: string; secrets: readonly string[] }): boolean {
  const compactText = stripWhitespace(input.text);
  for (const secret of input.secrets) {
    const normalized = normalizeForScan(secret);
    if (normalized.length < OUTBOUND_MIN_SECRET_LENGTH) {
      continue;
    }
    for (const variant of [normalized, encodeURIComponent(normalized)]) {
      if (input.text.includes(variant) || compactText.includes(stripWhitespace(variant))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks the strings of one outbound call. `secrets` are the exact values the server holds
 * (provider keys, OAuth tokens and client secrets, the API key, other configured secrets); a query
 * containing one verbatim is blocked. Everything else is pattern based.
 */
export function checkOutboundStrings(input: {
  strings: OutboundStrings;
  secrets: readonly string[];
}): OutboundGuardVerdict {
  const values = [...input.strings.values, ...input.strings.scalars].map(normalizeForScan);
  const keys = input.strings.keys.map(normalizeForScan);
  const text = [...values, ...keys].join('\n');
  // Adjacent values glued together: a key split across array items still shows its prefix.
  const glued = values.join('');

  if (
    containsServerSecret({ text, secrets: input.secrets }) ||
    containsServerSecret({ text: glued, secrets: input.secrets })
  ) {
    return { ok: false, rule: 'server_secret' };
  }
  if (PRIVATE_KEY_BLOCK.test(text) || PRIVATE_KEY_BLOCK.test(glued)) {
    return { ok: false, rule: 'private_key' };
  }
  if (JWT.test(text) || JWT.test(glued)) {
    return { ok: false, rule: 'jwt' };
  }
  if (KEY_PREFIXES.some(pattern => pattern.test(text) || pattern.test(glued))) {
    return { ok: false, rule: 'key_prefix' };
  }
  if (isEncodedRun(text)) {
    return { ok: false, rule: 'encoded_run' };
  }
  if (PASSWORD_LABEL.test(text) || PASSCODE_THEN_DIGITS.test(text)) {
    return { ok: false, rule: 'password_label' };
  }
  if (hasCardNumber(text)) {
    return { ok: false, rule: 'card_number' };
  }
  if (values.reduce((total, value) => total + value.length, 0) > OUTBOUND_MAX_CHARS) {
    return { ok: false, rule: 'too_long' };
  }
  return { ok: true };
}

/** Plain-language reason for a rule, for approval cards and audit rows. Never includes the text itself. */
export function describeOutboundRule(rule: OutboundGuardRule): string {
  switch (rule) {
    case 'server_secret':
      return 'it contains a secret this server holds';
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
      return `it is longer than ${String(OUTBOUND_MAX_CHARS)} characters`;
    case 'uninspectable':
      return 'its arguments are too large to inspect';
  }
}
