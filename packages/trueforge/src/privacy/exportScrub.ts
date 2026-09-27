/**
 * Secret scrubbing for the privacy export.
 *
 * The export contains the caller's own data verbatim (chats, memory files,
 * personas, schedules) because they asked for it. This module redacts only
 * high-confidence credential-shaped values so a leaked API key in a pasted
 * chat transcript does not ship inside the zip. Model provider configs are
 * excluded from the export entirely (they hold live API keys); scrubbing is
 * the second layer, not the first.
 */

export const SCRUBBED = '[redacted]';

/** JSON keys whose values are always secrets. */
const SECRET_KEYS = new Set([
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'private_key',
  'client_secret',
  'authorization',
]);

/** Credential-shaped values, wherever they appear. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9-_]{16,}\b/, // OpenAI-style keys
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub classic PATs
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // GitHub fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{20,}/, // Bearer <redacted>
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, // PEM blocks
];

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/** Deep-walks a JSON-ish value, redacting credential-shaped strings. */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return isSecretValue(value) ? SCRUBBED : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubSecrets(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? SCRUBBED : scrubSecrets(entry);
    }
    return out;
  }
  return value;
}
