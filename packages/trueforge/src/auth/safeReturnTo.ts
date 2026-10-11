import { getPublicUiBasePath } from '../config';

/** Backslash and percent-encoded backslash or control characters: browsers fold these into `/`. */
const ENCODED_UNSAFE = /%(?:5c|[01][0-9a-f]|7f)/i;

function hasUnsafeCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return ENCODED_UNSAFE.test(value);
}

/**
 * Same-origin relative path only.
 * - starts with a single `/`, not followed by `/` or `\` (open redirect)
 * - no backslash or control character anywhere, raw or percent-encoded
 * - not `/api` or `/api/…`
 */
function isSafeReturnTo(value: string): boolean {
  return /^\/(?![/\\]|api(?:\/|$))/.test(value) && !hasUnsafeCharacter(value);
}

/** Same-origin path, or the public UI home when missing or unsafe. */
export function safeReturnTo(value: string | undefined): string {
  if (value && isSafeReturnTo(value)) {
    return value;
  }
  return getPublicUiBasePath();
}
