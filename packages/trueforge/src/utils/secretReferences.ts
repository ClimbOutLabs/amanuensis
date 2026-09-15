/**
 * Secret reference syntax for stored config values: `${env:NAME}` and `${file:PATH}`.
 *
 * A reference is a pointer, not a secret — it is safe to persist, display, and edit as-is.
 * Resolution (reading the environment or the file) happens only at the point of use, on every
 * call, and is never cached or persisted: callers get a fresh value each time, so rotating the
 * underlying env var or file content takes effect without restarting anything that resolved it.
 *
 * Resolution failures never include the resolved value (there isn't one) and are safe to log.
 */
import { readFile } from 'node:fs/promises';

// The target excludes `}` so a concatenation like `${env:FOO} ${env:BAR}` cannot match as one
// reference — the first `}` must be the final character, not merely a later one.
const SECRET_REFERENCE_PATTERN = /^\$\{(?:env|file):[^}]+\}$/;

/** True when `value` is exactly a `${env:NAME}` or `${file:PATH}` reference (not merely containing one). */
export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE_PATTERN.test(value);
}

export type SecretReference = { kind: 'env'; name: string } | { kind: 'file'; path: string };

/** Parses a reference string. Returns `undefined` for anything that is not an exact-match reference. */
export function parseSecretReference(value: string): SecretReference | undefined {
  if (!isSecretReference(value)) {
    return undefined;
  }
  // isSecretReference already anchored the shape to `${(env|file):<1+ chars>}`, so slicing off the
  // wrapper and splitting on the first colon cannot land on an empty kind or target.
  const body = value.slice('${'.length, -'}'.length);
  const separatorIndex = body.indexOf(':');
  const kind = body.slice(0, separatorIndex);
  const target = body.slice(separatorIndex + 1);
  if (kind === 'env') {
    return { kind: 'env', name: target };
  }
  return { kind: 'file', path: target };
}

/** Thrown when a reference fails to resolve. Message names the reference and never the value. */
export class SecretReferenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretReferenceError';
  }
}

/** Strips trailing CR/LF sequences only — no other whitespace is touched. */
function trimTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

/**
 * Resolves one secret reference. `${env:NAME}` reads `process.env` directly rather than through
 * `config.ts`: NAME is user-supplied and only known once a stored manifest is loaded, so it cannot
 * be one of config.ts's fixed, statically-known startup keys. This is the documented special
 * requirement carved out by the repo's env-read rule.
 * `${file:PATH}` reads the file as utf-8 and trims trailing newline(s) only.
 * @throws {SecretReferenceError} naming the reference and the failure reason, never any value
 */
export async function resolveSecretReference(reference: string): Promise<string> {
  const parsed = parseSecretReference(reference);
  if (parsed === undefined) {
    throw new SecretReferenceError(`"${reference}" is not a valid secret reference`);
  }
  if (parsed.kind === 'env') {
    const value = process.env[parsed.name];
    if (value === undefined) {
      throw new SecretReferenceError(
        `Secret reference ${reference} could not be resolved: environment variable "${parsed.name}" is not set`,
      );
    }
    return value;
  }
  let raw: string;
  try {
    raw = await readFile(parsed.path, 'utf-8');
  } catch (error) {
    throw new SecretReferenceError(
      `Secret reference ${reference} could not be resolved: file "${parsed.path}" could not be read`,
      { cause: error },
    );
  }
  return trimTrailingNewlines(raw);
}
