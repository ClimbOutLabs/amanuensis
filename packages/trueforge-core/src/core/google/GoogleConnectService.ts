import type { Logger } from 'winston';
import { z } from 'zod';
import { generateOAuthState } from '../util/oauthState';
import { checkClientWithGoogle } from './checkClient';
import { clientProblems, type ClientProblem, type ClientType } from './clientJson';
import type {
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleOwner,
  PendingGoogleAuthorizationStore,
} from './connection';
import { GoogleOAuthError, GoogleReconnectRequiredError } from './errors';
import { GoogleAccessTokens } from './GoogleAccessTokens';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchProfileEmail,
  generatePkceVerifier,
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

/** Thrown before any consent when the features asked for cannot work together. */
export class GoogleFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleFeatureError';
  }
}

/** The consent in flight is missing, expired, or was started by a different request. */
export class GoogleConsentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoogleConsentError';
  }
}

const GOOGLE_TEST_OUTCOMES = ['ok', 'not_connected', 'needs_reconnect', 'unreachable'] as const;

export const GoogleTestResultSchema = z.object({
  result: z.enum(GOOGLE_TEST_OUTCOMES),
  account_email: z.string().nullable().describe('The connected address when the test passed.'),
});
export type GoogleTestResult = z.infer<typeof GoogleTestResultSchema>;

/** `removed_unconfirmed`: the login is gone here, but Google did not confirm it revoked Aman's access. */
export type GoogleDisconnectResult = 'revoked' | 'removed_unconfirmed';

/** What is safe to log about a failure: its kind and Google's status and code, never a message that could carry a token. */
function safeFailureFields(error: unknown): Record<string, string | number | null> {
  return error instanceof GoogleOAuthError
    ? { error_name: error.name, status: error.status, code: error.code }
    : { error_name: error instanceof Error ? error.name : typeof error };
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
  readonly #logger: Logger;

  constructor(input: {
    connections: GoogleConnectionStore;
    pending: PendingGoogleAuthorizationStore;
    now: (() => Date) | undefined;
    fetchImpl: typeof fetch | undefined;
    logger: Logger;
  }) {
    this.#logger = input.logger;
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
    if (!features.includes('gmail_read')) {
      throw new GoogleFeatureError(
        features.includes('gmail_compose')
          ? 'Sending needs permission to read mail too. Tick the read box as well, then connect.'
          : 'Calendar is added to a Google connection that already reads mail. Connect Google first, then add Calendar.',
      );
    }
    const scopes = scopesForFeatures(features);
    const state = generateOAuthState();
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

  /**
   * Finishes the consent the user started: checks the state, trades the code, names the account, stores the
   * login. A state that is not the one in flight spends nothing, so the real attempt can still finish.
   */
  async complete(input: { owner: GoogleOwner; state: string; code: string }): Promise<GoogleConnectionRecord> {
    const pending = await this.#pending.takePending({ ...input.owner, state_hash: hashState(input.state) });
    if (pending === null) {
      throw new GoogleConsentError(
        (await this.#pending.hasPending(input.owner))
          ? 'That response does not belong to the connection in progress. Use the address from the page Google just opened.'
          : 'There is no connection in progress.',
      );
    }
    if (this.#now().getTime() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
      throw new GoogleConsentError('That connection attempt took too long.');
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
      throw new GoogleConsentError('Google did not accept the code.', { cause: error });
    }
    let accountEmail: string;
    try {
      accountEmail = await fetchProfileEmail({ access_token: tokens.access_token, fetchImpl: this.#fetchImpl });
    } catch (error) {
      const refused = error instanceof GoogleOAuthError && error.status === 403;
      throw new GoogleConsentError(
        refused && !grantedFeatures(tokens.scopes).includes('gmail_read')
          ? "Aman wasn't given permission to read mail. Connect again and leave the read box ticked."
          : refused
            ? 'You signed in, but Gmail would not answer. Check that the Gmail API is turned on in your Google project (step 2), then connect again.'
            : 'You signed in, but Aman could not reach Gmail. Try connecting again in a minute.',
        { cause: error },
      );
    }
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
      return { result: 'not_connected', account_email: null };
    }
    const tokens = new GoogleAccessTokens({
      now: undefined,
      connections: this.#connections,
      owner,
      fetchImpl: this.#fetchImpl,
    });
    try {
      const access = await tokens.get();
      const accountEmail = await fetchProfileEmail({ access_token: access.access_token, fetchImpl: this.#fetchImpl });
      if (accountEmail !== record.account_email) {
        // Conditional on the row read, so a disconnect or reconnect during the test is not overwritten.
        await this.#connections.setAccountEmail({
          owner,
          expected: { refresh_token: record.refresh_token, updated_at: record.updated_at },
          account_email: accountEmail,
          updated_at: this.#now().toISOString(),
        });
      }
      return { result: 'ok', account_email: accountEmail };
    } catch (error) {
      if (error instanceof GoogleReconnectRequiredError) {
        return { result: 'needs_reconnect', account_email: null };
      }
      this.#logger.warn('Google connection test failed', safeFailureFields(error));
      return { result: 'unreachable', account_email: null };
    }
  }

  /**
   * Revokes the login at Google, then deletes it here. When Google cannot confirm the revocation the login
   * is still deleted, so Disconnect never gets stuck; the caller tells the user to check their Google account.
   */
  async disconnect(owner: GoogleOwner): Promise<GoogleDisconnectResult> {
    const record = await this.#connections.get(owner);
    let result: GoogleDisconnectResult = 'revoked';
    if (record !== null) {
      try {
        await revokeToken({ token: record.refresh_token, fetchImpl: this.#fetchImpl });
      } catch (error) {
        this.#logger.warn('Google did not confirm the revocation', safeFailureFields(error));
        result = 'removed_unconfirmed';
      }
    }
    await this.#pending.clearPending(owner);
    await this.#connections.delete(owner);
    return result;
  }
}
