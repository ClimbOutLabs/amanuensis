/**
 * Secret scrubbing for every byte the data export writes, in two layers:
 *
 * 1. Exact match: each secret value this server holds is removed from text,
 *    including chat text and memory files. Identity fields (ids, names, paths)
 *    and uploaded files are never rewritten.
 * 2. Shape match: credential-shaped substrings and secret-named JSON keys are
 *    redacted even when they are not stored secrets (a key pasted into a chat).
 *
 * Both layers replace only the matched span, so the text around it survives.
 * Each replacement is counted so the manifest can report how much was removed.
 */

export const REDACTED = '[redacted]';

/** Stored values at least this long are matched anywhere in content. */
export const MIN_SECRET_LENGTH = 16;

/**
 * Shorter stored values, down to this length, are matched only as a whole token and only when
 * they hold a digit or symbol. A letters-only value (the compose default database password
 * `trueforge`) is also an ordinary word, and matching it would rewrite the owner's chat text.
 */
export const MIN_TOKEN_SECRET_LENGTH = 8;

function isMatchableSecret(candidate: string): boolean {
  return (
    candidate.length >= MIN_SECRET_LENGTH ||
    (candidate.length >= MIN_TOKEN_SECRET_LENGTH && /[^A-Za-z]/.test(candidate))
  );
}

/** Long values match anywhere; short ones only where no letter or digit touches either end. */
function secretMatcher(secret: string): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return secret.length >= MIN_SECRET_LENGTH
    ? new RegExp(escaped, 'g')
    : new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g');
}

const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(['key', 'path', 'digest', 'archive_entry']);

/** Identity fields an import keys on; their string values are never rewritten, or the restored data no longer fits together. */
function isStructuralKey(key: string): boolean {
  return key === 'id' || key.endsWith('_id') || key === 'name' || key.endsWith('_name') || STRUCTURAL_KEYS.has(key);
}

/** Words that mark a field name as a credential, matched after dropping case and separators. */
const CREDENTIAL_WORDS =
  'authorization|cookies?|password|passwd|secret|token|apikey|privatekey|secretkey|accesskey|encryptionkey|signingkey|credentials?|verifier|oauthcode|authcode';

const CREDENTIAL_SUFFIX = new RegExp(`(?:${CREDENTIAL_WORDS})$`);
const CREDENTIAL_WORD = new RegExp(CREDENTIAL_WORDS);

/** Lowercase with separators dropped, so `apiKey`, `api_key` and `API-KEY` compare equal. */
export function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Export rule: a name ending in a credential word hides any value, numbers and flags included.
 * Anchoring keeps counts and descriptors (`input_tokens_breakdown`, `credential_type`) intact for import.
 */
export function isExportCredentialField(key: string, value: unknown): boolean {
  const present = value !== null && value !== undefined && value !== '';
  return present && CREDENTIAL_SUFFIX.test(normalizeFieldName(key));
}

/**
 * Log rule: a credential word anywhere in the name hides text and structures.
 * Numbers and flags stay, so counts and switches such as `max_tokens` and `hasToken` remain readable.
 */
export function isLogCredentialField(key: string, value: unknown): boolean {
  const holdsText = typeof value === 'string' || (typeof value === 'object' && value !== null);
  return holdsText && CREDENTIAL_WORD.test(normalizeFieldName(key));
}

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
  // PEM private key through its END line; a block cut off before END is redacted to the end of the text.
  /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
  // Password inside a URL (`postgres://user:password@host`); the user and host stay.
  /(?<=\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
];

/** Credential-shaped substrings replaced in free text, without counting them. */
export function redactSecretShapes(text: string): string {
  return SECRET_VALUE_PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

export function normalizeSecrets(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    // A header value is often `Bearer <token>`: the bare token is what a user
    // pastes into a chat or a memory note, so each whitespace part counts too.
    for (const candidate of [value, ...value.split(/\s+/)]) {
      if (isMatchableSecret(candidate)) {
        seen.add(candidate);
      }
    }
  }
  // Longest first, so a secret that contains another secret is removed whole.
  return [...seen].sort((a, b) => b.length - a.length);
}

export interface ExportScrubber {
  /** Scrubs every string in a JSON value except identity fields, and the value of every secret-named key. */
  json(value: unknown): unknown;
  /** Scrubs free text (Markdown, memory files). Uploaded files are the owner's own and are never passed here. */
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
  const secretMatchers = secrets.map(secretMatcher);

  function scrubText(input: string): string {
    let out = input;
    for (const pattern of [...secretMatchers, ...SECRET_VALUE_PATTERNS]) {
      out = out.replace(pattern, () => {
        redactions += 1;
        return REDACTED;
      });
    }
    return out;
  }

  function holdsSecret(input: string): boolean {
    return [...secretMatchers, ...SECRET_VALUE_PATTERNS].some(pattern => input.search(pattern) !== -1);
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
        if (isExportCredentialField(key, entry)) {
          redactions += 1;
          out[key] = REDACTED;
        } else if (isStructuralKey(key) && typeof entry === 'string') {
          out[key] = entry;
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
