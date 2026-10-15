import { timingSafeEqual } from 'node:crypto';
import { checkClientWithGoogle } from './checkClient';
import { clientProblems, type ClientProblem, type ClientType } from './clientJson';
import type {
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleOwner,
  PendingGoogleAuthorizationStore,
} from './connection';
import { GoogleReconnectRequiredError } from './errors';
import { GoogleAccessTokens } from './GoogleAccessTokens';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchProfileEmail,
  generatePkceVerifier,
  generateState,
  hashState,
  revokeToken,
} from './oauth';
import { grantedFeatures, scopesForFeatures, type GoogleFeature } from './scopes';
import type { GoogleSetupInfo } from './setupMode';

/** A consent in flight is good for this long; after it the user starts again. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** The client the user typed or dropped in. Absent, the stored client is reused (adding a feature, reconnecting). */
export interface GoogleClientInput {
  client_id: string;
  client_secret: string;
  client_type: ClientType | null;
}

/** Thrown before any consent when the client cannot work; carries the plain-language problems. */
export class GoogleClientError extends Error {
  readonly problems: ClientProblem[];

  constructor(problems: ClientProblem[]) {
    super(problems.map(problem => problem.message).join(' '));
    this.name = 'GoogleClientError';
    this.problems = problems;
  }
}

/** The consent in flight is missing, expired, or was started by a different request. */
export class GoogleConsentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoogleConsentError';
  }
}

export type GoogleTestResult =
  { ok: true; account_email: string } | { ok: false; reason: 'not_connected' | 'needs_reconnect' | 'unreachable' };

export type GoogleDisconnectResult = 'disconnected' | 'revoke_failed';

function sameHash(input: { left: string; right: string }): boolean {
  const a = Buffer.from(input.left);
  const b = Buffer.from(input.right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The connect flow behind Settings, Connectors, Google. The user's own client, PKCE, one login per user.
 * A later consent for another feature replaces the stored login with the wider one and never revokes the
 * one it replaced: Google keeps one grant per user and client, so revoking the old token would end the
 * new one too. Only Disconnect revokes.
 */
export class GoogleConnectService {
  readonly #connections: GoogleConnectionStore;
  readonly #pending: PendingGoogleAuthorizationStore;
  readonly #now: () => Date;
  readonly #fetchImpl: typeof fetch;

  constructor(input: {
    connections: GoogleConnectionStore;
    pending: PendingGoogleAuthorizationStore;
    now?: (() => Date) | undefined;
    fetchImpl?: typeof fetch | undefined;
  }) {
    this.#connections = input.connections;
    this.#pending = input.pending;
    this.#now = input.now ?? (() => new Date());
    this.#fetchImpl = input.fetchImpl ?? fetch;
  }

  /** "Check my client": local checks, then a dry request to Google. Empty means nothing was wrong. */
  async checkClient(input: {
    client: GoogleClientInput;
    registered_redirect_uris: readonly string[];
    setup: GoogleSetupInfo;
  }): Promise<ClientProblem[]> {
    const local = clientProblems({
      ...input.client,
      registered_redirect_uris: input.registered_redirect_uris,
      setup: input.setup,
    });
    if (local.length > 0) {
      return local;
    }
    return await checkClientWithGoogle({
      client_id: input.client.client_id.trim(),
      redirect_uri: input.setup.redirect_uri,
      scopes: scopesForFeatures(['gmail_read']),
      fetchImpl: this.#fetchImpl,
    });
  }

  /**
   * Starts a consent and returns the Google address to open. The features asked for are joined with the
   * ones already granted, so a second consent only ever widens the login.
   */
  async begin(input: {
    owner: GoogleOwner;
    setup: GoogleSetupInfo;
    client: GoogleClientInput | null;
    features: readonly GoogleFeature[];
  }): Promise<{ authorization_url: string }> {
    const stored = await this.#connections.get(input.owner);
    const client =
      input.client ??
      (stored === null
        ? null
        : { client_id: stored.client_id, client_secret: stored.client_secret, client_type: stored.client_type });
    if (client === null) {
      throw new GoogleClientError([
        {
          code: 'invalid_client_id',
          message: 'Enter your Google client ID and secret to connect.',
        },
      ]);
    }
    const problems = clientProblems({
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_type: client.client_type,
      registered_redirect_uris: [],
      setup: input.setup,
    });
    if (problems.length > 0) {
      throw new GoogleClientError(problems);
    }
    const features = [...input.features, ...grantedFeatures(stored?.granted_scopes ?? [])];
    const scopes = scopesForFeatures(features);
    const state = generateState();
    const pkceVerifier = generatePkceVerifier();
    await this.#pending.savePending({
      ...input.owner,
      state_hash: hashState(state),
      pkce_verifier: pkceVerifier,
      client_id: client.client_id.trim(),
      client_secret: client.client_secret.trim(),
      client_type: input.setup.client_type,
      redirect_uri: input.setup.redirect_uri,
      scopes,
      created_at: this.#now().toISOString(),
    });
    return {
      authorization_url: buildAuthorizationUrl({
        client_id: client.client_id.trim(),
        redirect_uri: input.setup.redirect_uri,
        scopes,
        state,
        pkce_verifier: pkceVerifier,
      }),
    };
  }

  /** Finishes the consent the user started: checks the state, trades the code, stores the login. */
  async complete(input: { owner: GoogleOwner; state: string; code: string }): Promise<GoogleConnectionRecord> {
    const pending = await this.#pending.takePending(input.owner);
    if (pending === null) {
      throw new GoogleConsentError('There is no connection in progress. Start again.');
    }
    if (this.#now().getTime() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
      throw new GoogleConsentError('That connection attempt took too long. Start again.');
    }
    if (!sameHash({ left: pending.state_hash, right: hashState(input.state) })) {
      throw new GoogleConsentError('That response does not belong to the connection in progress. Start again.');
    }
    let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
    try {
      tokens = await exchangeCodeForTokens({
        client: { client_id: pending.client_id, client_secret: pending.client_secret },
        code: input.code,
        pkce_verifier: pending.pkce_verifier,
        redirect_uri: pending.redirect_uri,
        fetchImpl: this.#fetchImpl,
      });
    } catch (error) {
      throw new GoogleConsentError('Google did not accept the code. Start again.', { cause: error });
    }
    const accountEmail = await fetchProfileEmail({
      access_token: tokens.access_token,
      fetchImpl: this.#fetchImpl,
    }).catch(() => null);
    const existing = await this.#connections.get(input.owner);
    const now = this.#now().toISOString();
    const record: GoogleConnectionRecord = {
      ...input.owner,
      client_id: pending.client_id,
      client_secret: pending.client_secret,
      client_type: pending.client_type,
      refresh_token: tokens.refresh_token,
      granted_scopes: tokens.scopes,
      account_email: accountEmail,
      status: 'connected',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await this.#connections.save(record);
    return record;
  }

  /** Checks the stored login against Google. A failure is the answer, not an exception. */
  async test(owner: GoogleOwner): Promise<GoogleTestResult> {
    const record = await this.#connections.get(owner);
    if (record === null) {
      return { ok: false, reason: 'not_connected' };
    }
    const tokens = new GoogleAccessTokens({ connections: this.#connections, owner, fetchImpl: this.#fetchImpl });
    try {
      const access = await tokens.get();
      const accountEmail = await fetchProfileEmail({ access_token: access.access_token, fetchImpl: this.#fetchImpl });
      if (accountEmail !== record.account_email) {
        await this.#connections.save({ ...record, account_email: accountEmail, updated_at: this.#now().toISOString() });
      }
      return { ok: true, account_email: accountEmail };
    } catch (error) {
      if (error instanceof GoogleReconnectRequiredError) {
        return { ok: false, reason: 'needs_reconnect' };
      }
      return { ok: false, reason: 'unreachable' };
    }
  }

  /**
   * Revokes the login at Google, then deletes it here. If Google cannot confirm, nothing is deleted and
   * the login stays so Disconnect can be tried again.
   */
  async disconnect(owner: GoogleOwner): Promise<GoogleDisconnectResult> {
    const record = await this.#connections.get(owner);
    if (record !== null) {
      try {
        await revokeToken({ token: record.refresh_token, fetchImpl: this.#fetchImpl });
      } catch {
        return 'revoke_failed';
      }
    }
    await this.#pending.takePending(owner);
    await this.#connections.delete(owner);
    return 'disconnected';
  }
}
