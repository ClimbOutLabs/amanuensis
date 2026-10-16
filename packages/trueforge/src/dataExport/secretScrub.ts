/**
 * Secret scrubbing for every byte the data export writes, in two layers:
 *
 * 1. Exact match: each secret value this server holds is removed wherever it
 *    appears, in any section, including inside chat text and memory files.
 * 2. Shape match: credential-shaped substrings and secret-named JSON keys are
 *    redacted even when they are not stored secrets (a key pasted into a chat).
 *
 * Both layers replace only the matched span, so the text around it survives.
 * Each replacement is counted so the manifest can report how much was removed.
 */

export const REDACTED = '[redacted]';

/** Stored values shorter than this are not treated as secrets: exact-matching them would redact ordinary words. */
export const MIN_SECRET_LENGTH = 8;

/** JSON keys whose values are always secrets. */
const SECRET_KEYS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'api_secret',
  'access_token',
  'refresh_token',
  'auth_token',
  'private_key',
  'client_secret',
  'authorization',
  'db_password',
  'webhook_secret',
  'signing_secret',
  'session_token',
]);

const CREDENTIAL_SCHEMES = 'postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|amqps?';

/** Credential-shaped values, wherever they appear. Each matches the whole credential, or only its secret part. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9-_]{16,}\b/g, // OpenAI-style keys
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g, // Stripe live keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs
  /\bglpat-[A-Za-z0-9-_]{20,}\b/g, // GitLab personal access tokens
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm tokens
  /\bAIza[0-9A-Za-z-_]{35}\b/g, // Google API keys
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{20,}/g, // Bearer <token>
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, // PEM blocks
  // Password inside a connection URL (`postgres://user:password@host`); the user and host stay.
  new RegExp(`(?<=\\b(?:${CREDENTIAL_SCHEMES})://[^\\s:@/]+:)[^\\s@/]+(?=@)`, 'g'),
];

export function normalizeSecrets(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    // A header value is often `Bearer <token>`: the bare token is what a user
    // pastes into a chat or a memory note, so each whitespace part counts too.
    for (const candidate of [value, ...value.split(/\s+/)]) {
      if (candidate.length >= MIN_SECRET_LENGTH) {
        seen.add(candidate);
      }
    }
  }
  // Longest first, so a secret that contains another secret is removed whole.
  return [...seen].sort((a, b) => b.length - a.length);
}

export interface ExportScrubber {
  /** Scrubs every string in a JSON value and the value of every secret-named key. */
  json(value: unknown): unknown;
  /** Scrubs free text (Markdown, file contents). */
  text(text: string): string;
  /**
   * A connector URL without credentials: userinfo, query and fragment are dropped, and any
   * path segment that holds a secret or credential-shaped value is replaced.
   */
  url(url: string): string;
  /** Replacements made so far, across all of the above. */
  redactionCount(): number;
}

/** `secrets` is the normalized exact-match set (see {@link normalizeSecrets}). */
export function createExportScrubber(secrets: readonly string[]): ExportScrubber {
  let redactions = 0;

  function scrubText(input: string): string {
    let out = input;
    for (const secret of secrets) {
      const parts = out.split(secret);
      if (parts.length > 1) {
        redactions += parts.length - 1;
        out = parts.join(REDACTED);
      }
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
      out = out.replace(pattern, () => {
        redactions += 1;
        return REDACTED;
      });
    }
    return out;
  }

  function holdsSecret(input: string): boolean {
    return secrets.some(secret => input.includes(secret)) || SECRET_VALUE_PATTERNS.some(p => input.search(p) !== -1);
  }

  function scrubUrl(input: string): string {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      redactions += 1;
      return REDACTED;
    }
    if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
      redactions += 1;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname
      .split('/')
      .map(segment => {
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          // A malformed escape is checked as written.
        }
        if (!holdsSecret(segment) && !holdsSecret(decoded)) {
          return segment;
        }
        redactions += 1;
        return REDACTED;
      })
      .join('/');
    return parsed.toString();
  }

  function scrubJson(value: unknown): unknown {
    if (typeof value === 'string') {
      return scrubText(value);
    }
    if (Array.isArray(value)) {
      return value.map(scrubJson);
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (SECRET_KEYS.has(key.toLowerCase()) && entry !== null && entry !== '') {
          redactions += 1;
          out[key] = REDACTED;
        } else {
          out[key] = scrubJson(entry);
        }
      }
      return out;
    }
    return value;
  }

  return { json: scrubJson, text: scrubText, url: scrubUrl, redactionCount: () => redactions };
}
