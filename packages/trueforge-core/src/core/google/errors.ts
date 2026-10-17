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
