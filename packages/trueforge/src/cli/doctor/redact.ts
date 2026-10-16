import { errorCode } from '../errorCode';

/** Keeps scheme, host and path only: credentials, query strings and fragments never reach a report. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '[invalid address]';
  }
}

/** Short reason for a failed request without echoing the address it used. */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error.cause);
    if (code !== undefined) {
      return code;
    }
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'timed out';
    }
  }
  return 'no answer';
}
