import { isValidTimezone } from '../util/clientTimezone';

/**
 * The one list of secret file and folder names the sentinel treats as private, and the matcher
 * that applies it. A path segment is split into words at camelCase humps and at any non-letter-or-digit
 * character, then matched word by word: `.git-credentials`, `client_secret.json` and `apiKey.txt`
 * are secret, while `secretary`, `tokenizer.ts` and `monkey.md` are ordinary names.
 */

/** Folders and dotfiles that hold keys or logins; a dotted suffix such as `.env.local` also matches. */
const SECRET_DOT_NAMES = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.netrc', '.pgpass', '.env'];

/** Words that name a secret wherever they appear in a file or folder name, as a whole word. */
const SECRET_WORDS = new Set([
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'apikey',
  'apikeys',
  'privkey',
  'privkeys',
]);

/**
 * Two adjacent words that name a secret together. The second word also matches with a trailing `s`,
 * so `api_keys` counts. A lone `key` or `token` is not listed here, so `keyboard` stays ordinary.
 */
const SECRET_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['private', 'key'],
  ['priv', 'key'],
  ['access', 'key'],
  ['secret', 'key'],
  ['client', 'secret'],
  ['auth', 'token'],
  ['refresh', 'token'],
  ['session', 'token'],
];

/** Key files: SSH key prefixes, and key or certificate suffixes. */
const SECRET_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa'];
const SECRET_KEY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

const QUOTE_CHARACTERS = `'"\``;

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/** A lowercase letter or digit followed by an uppercase letter, or an acronym followed by a capitalised word. */
const LOWER_TO_UPPER_HUMP = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const ACRONYM_TO_WORD_HUMP = /(\p{Lu})(\p{Lu}\p{Ll})/gu;
/** Letters and digits meet at a boundary, so `token2` is the word `token` and the number `2`. */
const LETTER_TO_DIGIT = /(\p{L})(\p{N})/gu;
const DIGIT_TO_LETTER = /(\p{N})(\p{L})/gu;

/** Splits a name into lowercase words. Humps are split before lowercasing, so `apiKey` and `API_KEY` both split. */
function splitWords(name: string): string[] {
  return name
    .replace(LOWER_TO_UPPER_HUMP, '$1 $2')
    .replace(ACRONYM_TO_WORD_HUMP, '$1 $2')
    .replace(LETTER_TO_DIGIT, '$1 $2')
    .replace(DIGIT_TO_LETTER, '$1 $2')
    .split(WORD_SEPARATOR)
    .map(word => word.toLowerCase())
    .filter(word => word.length > 0);
}

function hasSecretWord(words: string[]): boolean {
  return words.some((word, index) => {
    if (SECRET_WORDS.has(word)) {
      return true;
    }
    const next = words[index + 1];
    return (
      next !== undefined &&
      SECRET_WORD_PAIRS.some(([first, second]) => word === first && (next === second || next === `${second}s`))
    );
  });
}

function isSecretSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    SECRET_DOT_NAMES.some(dot => name === dot || name.startsWith(`${dot}.`)) ||
    hasSecretWord(splitWords(segment)) ||
    SECRET_KEY_PREFIXES.some(prefix => name.startsWith(prefix)) ||
    SECRET_KEY_SUFFIXES.some(suffix => name.endsWith(suffix))
  );
}

/** Removes quote marks around a word. A plain loop keeps long input linear. */
function stripQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && QUOTE_CHARACTERS.includes(text.charAt(start))) {
    start += 1;
  }
  while (end > start && QUOTE_CHARACTERS.includes(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
}

/** Division, fraction, big solidus and fullwidth slashes, which read as a path separator. */
const LOOK_ALIKE_SLASH = /[\u2215\u2044\u29F8\uFF0F\uFF3C]/gu;
/** A run of valid percent escapes, which may be a multi-byte character such as `%E2%88%95`. */
const PERCENT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const ASCII_PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;
/** Decoding stops after this many rounds, so `%252e` counts as `.`, and a deeper nest is left as text. */
const MAX_DECODE_ROUNDS = 3;

function foldSlashes(text: string): string {
  return text.normalize('NFKC').replace(LOOK_ALIKE_SLASH, ch => (ch === '\uFF3C' ? '\\' : '/'));
}

/**
 * Decodes percent escapes. A run that is not valid UTF-8 still decodes its ASCII escapes, so a slash
 * cannot hide behind a broken multi-byte sequence.
 */
function decodeEscapes(text: string): string {
  return text.replace(PERCENT_ESCAPE_RUN, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(ASCII_PERCENT_ESCAPE, (escape, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code < 0x80 ? String.fromCharCode(code) : escape;
      });
    }
  });
}

/**
 * The one normalizer every path check reads through: NFKC, look-alike slashes folded to `/` and `\\`,
 * and percent escapes decoded again after each round, so a path cannot hide in an encoded or
 * full-width form.
 */
function normalizePathText(text: string): string {
  let current = foldSlashes(text);
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const decoded = foldSlashes(decodeEscapes(current));
    if (decoded === current) {
      break;
    }
    current = decoded;
  }
  return current;
}

/** A word that has a path shape: a separator, a leading `~` or dot, or a dot inside a name. */
function looksLikePathWord(word: string): boolean {
  return /[/\\]/.test(word) || /^[~.]/.test(word) || /\.\w/.test(word);
}

function segmentsName(text: string): boolean {
  return text.split(/[/\\]/).some(isSecretSegment);
}

/**
 * Whether one string names a secret path, or is itself a secret name. A value with no spaces is
 * checked whole, so a bare `credentials` counts, and so does a path with spaces, checked as one path.
 * Inside other free text only a word with a path shape is checked, so a search that mentions a secret
 * word is not a read of one.
 */
export function namesSecretPath(text: string): boolean {
  const whole = stripQuotes(normalizePathText(text).trim());
  if ((!/\s/.test(whole) || /[/\\]/.test(whole)) && segmentsName(whole)) {
    return true;
  }
  return whole
    .split(/\s+/)
    .map(stripQuotes)
    .some(word => looksLikePathWord(word) && segmentsName(word));
}

/** A drive letter at the start, such as `C:`. */
const DRIVE_LETTER = /^[A-Za-z]:/;
/** A file name with an extension: a word character, a dot, then a letter that starts the extension. */
const FILE_EXTENSION = /[\p{L}\p{N}_-]\.\p{L}[\p{L}\p{N}]{0,9}/u;
/**
 * Whether a string has a path shape after normalization: a slash or backslash, a leading `~`, `.` or
 * drive letter, or a word with a file extension. An email address is not a path. A whole value the
 * calendar accepts as a time zone, such as `America/New_York`, is not one either, so a `timeZone`
 * argument keeps its grant. Intl rejects path strings, so that check cannot exempt a real path.
 */
function isPathLikeText(text: string): boolean {
  const whole = stripQuotes(normalizePathText(text).trim());
  if (/[/\\]/.test(whole) || whole.startsWith('~') || whole.startsWith('.') || DRIVE_LETTER.test(whole)) {
    return !isValidTimezone(whole);
  }
  return whole
    .split(/\s+/)
    .map(stripQuotes)
    .some(word => !word.includes('@') && FILE_EXTENSION.test(word));
}

/** Whether any string at any depth of a value passes the test, and key names too when `checkKeys` is set. */
function anyStringIn(value: unknown, test: (text: string) => boolean, { checkKeys }: { checkKeys: boolean }): boolean {
  if (typeof value === 'string') {
    return test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => anyStringIn(item, test, { checkKeys }));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => (checkKeys && test(key)) || anyStringIn(item, test, { checkKeys }),
    );
  }
  return false;
}

/** Whether any string at any depth of a value names a secret path. Key names are not checked. */
export function containsSecretPath(value: unknown): boolean {
  return anyStringIn(value, namesSecretPath, { checkKeys: false });
}

/** Whether any string or key at any depth of a value has a path shape. */
export function containsPathLikeValue(value: unknown): boolean {
  return anyStringIn(value, isPathLikeText, { checkKeys: true });
}
