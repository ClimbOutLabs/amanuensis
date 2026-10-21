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

/** Splits a name into lowercase words. Humps are split before lowercasing, so `apiKey` and `API_KEY` both split. */
function splitWords(name: string): string[] {
  return name
    .replace(LOWER_TO_UPPER_HUMP, '$1 $2')
    .replace(ACRONYM_TO_WORD_HUMP, '$1 $2')
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

/** A word that has a path shape: a separator, a leading `~` or dot, or a dot inside a name. */
function looksLikePathWord(word: string): boolean {
  return /[/\\]/.test(word) || /^[~.]/.test(word) || /\.\w/.test(word);
}

function segmentsName(text: string): boolean {
  return text.split(/[/\\]/).some(isSecretSegment);
}

/**
 * Whether one string names a secret path, or is itself a secret name. A value with no spaces is
 * checked whole, so a bare `credentials` counts. Inside free text only a word with a path shape is
 * checked, so a search that mentions a secret word is not a read of one.
 */
export function namesSecretPath(text: string): boolean {
  const whole = stripQuotes(text.trim());
  if (!/\s/.test(whole) && segmentsName(whole)) {
    return true;
  }
  return whole
    .split(/\s+/)
    .map(stripQuotes)
    .some(word => looksLikePathWord(word) && segmentsName(word));
}

/** Whether any string at any depth of a value names a secret path. Key names are not checked. */
export function containsSecretPath(value: unknown): boolean {
  if (typeof value === 'string') {
    return namesSecretPath(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretPath);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsSecretPath);
  }
  return false;
}
