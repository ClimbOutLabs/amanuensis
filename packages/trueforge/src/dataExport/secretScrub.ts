/**
 * The data export's two secret layers, applied to every section before any
 * byte is written:
 *
 * 1. Exact-match removal: every stored secret value collected from the
 *    instance (see ./secretCollection) is removed wherever it appears, in
 *    any section, including inside chat text and memory files.
 * 2. The privacy export's credential scrub: credential-shaped values and
 *    secret-named JSON keys are redacted even when they are not stored
 *    secrets (for example a key a user pasted into a chat).
 */
import { SCRUBBED, scrubCredentialPatternsInText, scrubSecrets } from '../privacy/exportScrub';

/** Stored values shorter than this are not treated as secrets: exact-matching them would redact ordinary words. */
export const MIN_SECRET_LENGTH = 8;

export function normalizeSecrets(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      seen.add(value);
    }
  }
  // Longest first, so a secret that contains another secret is removed whole.
  return [...seen].sort((a, b) => b.length - a.length);
}

function removeFromText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join(SCRUBBED);
    }
  }
  return out;
}

/** Layer 1 for JSON values: deep-walks and removes stored secret values from every string. */
export function removeStoredSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) {
    return value;
  }
  if (typeof value === 'string') {
    return removeFromText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map(item => removeStoredSecrets(item, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = removeStoredSecrets(entry, secrets);
    }
    return out;
  }
  return value;
}

/** Both layers for a JSON section value, in order: exact removal, then the credential scrub. */
export function scrubJsonForExport(value: unknown, secrets: readonly string[]): unknown {
  return scrubSecrets(removeStoredSecrets(value, secrets));
}

/** Both layers for a free-text (Markdown) section, in order. */
export function scrubTextForExport(text: string, secrets: readonly string[]): string {
  return scrubCredentialPatternsInText(removeFromText(text, secrets));
}
