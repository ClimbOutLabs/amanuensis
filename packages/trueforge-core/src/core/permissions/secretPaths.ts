/**
 * The one list of secret file and folder names the sentinel treats as private, and the matcher
 * that applies it. A name matches a whole path segment, or the part before its first dot, never a
 * substring: `secretary` and `tokenizer.ts` are ordinary names.
 */

/** Folders and dotfiles that hold keys or logins; a dotted suffix such as `.env.local` also matches. */
const SECRET_DOT_NAMES = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.netrc', '.pgpass', '.env'];

/** Names whose stem (the part before the first dot) is the secret: `secrets.json`, `token`. */
const SECRET_STEM_NAMES = ['credentials', 'secret', 'secrets', 'token', 'tokens'];

/** Key files: SSH key prefixes, and key or certificate suffixes. */
const SECRET_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa'];
const SECRET_KEY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

const QUOTE_CHARACTERS = `'"\``;

function isSecretSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    SECRET_DOT_NAMES.some(dot => name === dot || name.startsWith(`${dot}.`)) ||
    SECRET_STEM_NAMES.some(stem => name === stem || name.startsWith(`${stem}.`)) ||
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
 * Whether one string names a secret path, or is itself a secret name. The whole value is always
 * checked, so a bare `credentials` counts. Inside free text only a word with a path shape is
 * checked, so a search that mentions a secret word is not a read of one.
 */
export function namesSecretPath(text: string): boolean {
  const whole = stripQuotes(text.trim());
  if (segmentsName(whole)) {
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
