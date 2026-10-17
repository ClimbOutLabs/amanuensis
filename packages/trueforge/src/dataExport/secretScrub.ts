import {
  CREDENTIAL_LABEL,
  JWT,
  KEY_PREFIXES,
  OUTBOUND_MIN_SECRET_LENGTH,
  PASSCODE_THEN_DIGITS,
  PASSWORD_LABEL,
  PRIVATE_KEY_BLOCK,
} from '@truefoundry/trueforge-core/core';

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

/** A path segment that reads as a token: a labelled value, a long mix of letters and digits, or a very long run. */
function looksLikeTokenSegment(segment: string): boolean {
  if (/^(?:tok|token|key|secret|pat|api)[_-][A-Za-z0-9_-]{8,}$/i.test(segment)) {
    return true;
  }
  if (segment.length >= 32 && /^[A-Za-z0-9_-]+$/.test(segment)) {
    return true;
  }
  return segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

function globally(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/** Credential shapes the outbound guard blocks; the guard owns the list so the two cannot drift. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [PRIVATE_KEY_BLOCK, JWT, ...KEY_PREFIXES].map(globally);

/** Label patterns hold the label in group 1 and the value in group 2; only the value is redacted. */
const SECRET_LABEL_PATTERNS: readonly RegExp[] = [PASSWORD_LABEL, PASSCODE_THEN_DIGITS, CREDENTIAL_LABEL].map(globally);

// Password inside a connection URL (`postgres://user:password@host`); the user and host stay.
const URL_PASSWORD = new RegExp(`(?<=\\b(?:${CREDENTIAL_SCHEMES})://[^\\s:@/]+:)[^\\s@/]+(?=@)`, 'g');

export function normalizeSecrets(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    // A header value is often `Bearer <token>`: the bare token is what a user
    // pastes into a chat or a memory note, so each whitespace part counts too.
    for (const candidate of [value, ...value.split(/\s+/)]) {
      if (candidate.length >= OUTBOUND_MIN_SECRET_LENGTH) {
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

/** `secrets` is the normalized exact-match set (see normalizeSecrets). */
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
    for (const pattern of [...SECRET_VALUE_PATTERNS, URL_PASSWORD]) {
      out = out.replace(pattern, () => {
        redactions += 1;
        return REDACTED;
      });
    }
    for (const pattern of SECRET_LABEL_PATTERNS) {
      out = out.replace(pattern, (_match, label: string) => {
        redactions += 1;
        return `${label}${REDACTED}`;
      });
    }
    return out;
  }

  function holdsSecret(input: string): boolean {
    return (
      secrets.some(secret => input.includes(secret)) ||
      [...SECRET_VALUE_PATTERNS, URL_PASSWORD].some(p => input.search(p) !== -1)
    );
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
        if (!holdsSecret(segment) && !holdsSecret(decoded) && !looksLikeTokenSegment(decoded)) {
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
