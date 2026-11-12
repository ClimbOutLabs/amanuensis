/** Google answered a token request with an error. `code` is Google's own error string, e.g. `invalid_grant`. */
export class GoogleOAuthError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(input: { message: string; code: string | null; status: number; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'GoogleOAuthError';
    this.code = input.code;
    this.status = input.status;
  }

  /**
   * The stored login no longer works: revoked, expired (a Testing-mode client lasts 7 days), or its client was
   * deleted or disabled (`invalid_client`, `unauthorized_client`).
   */
  get needsReconnect(): boolean {
    return this.code === 'invalid_grant' || this.code === 'invalid_client' || this.code === 'unauthorized_client';
  }
}

/** The user's Google login must be redone before Google can be used again. */
export class GoogleReconnectRequiredError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Google needs to be connected again. Open Settings, Connectors, Google and choose Reconnect.', options);
    this.name = 'GoogleReconnectRequiredError';
  }
}

/** Google reasons that only mean "too fast" or "a hiccup", which a 403 or a 5xx can carry. */
const BUSY_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'backendError']);

/** Whether a failure says Google is busy or failing, so asking again later can work. The one place this is decided. */
export function isBusyFailure(input: { status: number; reason: string }): boolean {
  return input.status === 429 || input.status >= 500 || BUSY_REASONS.has(input.reason);
}

/** Google refused or failed a REST request. The message is safe to show; it never carries mail or event text. */
export class GoogleApiError extends Error {
  readonly status: number;
  /** Whether Google was only too busy or too slow, so asking again later can work. A 403 for going too fast is busy. */
  readonly busy: boolean;

  constructor(input: { status: number; message: string; cause?: unknown; busy?: boolean }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'GoogleApiError';
    this.status = input.status;
    this.busy = input.busy ?? isBusyFailure({ status: input.status, reason: '' });
  }
}

/**
 * Google answered, but with a reply Aman cannot take in: it is over the size Aman reads, or it does not parse. Asking
 * again gets the same reply, unlike a busy or failing Google. The status stays 502.
 */
export class GoogleUnusableReplyError extends GoogleApiError {
  constructor(input: { message: string; cause?: unknown }) {
    super({ status: 502, busy: false, ...input });
    this.name = 'GoogleUnusableReplyError';
  }
}
