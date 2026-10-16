import type { GoogleConnectionStore, GoogleOwner } from './connection';
import { GoogleOAuthError, GoogleReconnectRequiredError } from './errors';
import { refreshAccessToken } from './oauth';

/** Seconds kept back from a token's lifetime so a call never starts on a token about to lapse. */
const EXPIRY_MARGIN_SECONDS = 60;

interface GoogleAccess {
  access_token: string;
  granted_scopes: string[];
  account_email: string | null;
}

/**
 * Access tokens for one user's stored login, refreshed on demand. A refresh Google rejects with
 * `invalid_grant` flips the login to needs-reconnect, so the Settings panel says so and the tools stop being
 * offered, instead of every call failing in a new way.
 */
export class GoogleAccessTokens {
  readonly #connections: GoogleConnectionStore;
  readonly #owner: GoogleOwner;
  readonly #now: () => number;
  readonly #fetchImpl: typeof fetch;
  #cached: { access: GoogleAccess; expires_at_ms: number } | null = null;

  constructor(input: {
    connections: GoogleConnectionStore;
    owner: GoogleOwner;
    now: (() => number) | undefined;
    fetchImpl: typeof fetch | undefined;
  }) {
    this.#connections = input.connections;
    this.#owner = input.owner;
    this.#now = input.now ?? Date.now;
    this.#fetchImpl = input.fetchImpl ?? fetch;
  }

  /** Forgets the cached token, so the next call refreshes. */
  invalidate(): void {
    this.#cached = null;
  }

  async get(): Promise<GoogleAccess> {
    if (this.#cached !== null && this.#cached.expires_at_ms > this.#now()) {
      return this.#cached.access;
    }
    const record = await this.#connections.get(this.#owner);
    if (record === null || record.status === 'needs_reconnect') {
      throw new GoogleReconnectRequiredError();
    }
    try {
      const refreshed = await refreshAccessToken({
        client: { client_id: record.client_id, client_secret: record.client_secret },
        refresh_token: record.refresh_token,
        fetchImpl: this.#fetchImpl,
      });
      const access: GoogleAccess = {
        access_token: refreshed.access_token,
        granted_scopes: record.granted_scopes,
        account_email: record.account_email,
      };
      this.#cached = {
        access,
        expires_at_ms: this.#now() + Math.max(refreshed.expires_in_seconds - EXPIRY_MARGIN_SECONDS, 0) * 1000,
      };
      return access;
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.needsReconnect) {
        await this.#connections.markNeedsReconnect({
          owner: this.#owner,
          expected: { refresh_token: record.refresh_token, updated_at: record.updated_at },
        });
        throw new GoogleReconnectRequiredError({ cause: error });
      }
      throw error;
    }
  }
}
