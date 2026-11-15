import type { IOAuthTokenStore, OAuthPendingAuthorization, OAuthToken, OAuthTokenKey } from '../mcp/auth/types';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

function tokenContext({ id, userRef, field }: OAuthTokenKey & { field: string }): SecretContext {
  return { table: 'oauth_token', primary_key: JSON.stringify([id, userRef]), field };
}

/**
 * Keeps connector sign-in tokens encrypted in the wrapped store. Callers pass and get the real
 * tokens. A token saved before encryption is read as it is until it is encrypted in place.
 */
export class EncryptedOAuthTokenStore<TTransaction = never> implements IOAuthTokenStore<TTransaction> {
  readonly #store: IOAuthTokenStore<TTransaction>;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: IOAuthTokenStore<TTransaction>; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  savePendingAuthorization(pending: OAuthPendingAuthorization, transaction?: TTransaction): Promise<void> {
    return this.#store.savePendingAuthorization(pending, transaction);
  }

  consumePendingAuthorization(
    params: { state: string },
    transaction?: TTransaction,
  ): Promise<OAuthPendingAuthorization | undefined> {
    return this.#store.consumePendingAuthorization(params, transaction);
  }

  async saveToken(params: OAuthTokenKey & { token: OAuthToken }, transaction?: TTransaction): Promise<void> {
    const seal = ({ value, field }: { value: string; field: string }): string =>
      this.#vault.encrypt({ plaintext: value, context: tokenContext({ ...params, field }) });
    const { refreshToken } = params.token;
    const token: OAuthToken = {
      ...params.token,
      accessToken: seal({ value: params.token.accessToken, field: 'token.accessToken' }),
      refreshToken: refreshToken === null ? null : seal({ value: refreshToken, field: 'token.refreshToken' }),
    };
    await this.#store.saveToken({ id: params.id, userRef: params.userRef, token }, transaction);
  }

  async getToken(params: OAuthTokenKey, transaction?: TTransaction): Promise<OAuthToken | undefined> {
    const token = await this.#store.getToken(params, transaction);
    return token === undefined ? undefined : this.#open({ ...params, token });
  }

  async getTokens(
    params: { ids: string[]; userRef: string },
    transaction?: TTransaction,
  ): Promise<Map<string, OAuthToken>> {
    const stored = await this.#store.getTokens(params, transaction);
    return new Map([...stored].map(([id, token]) => [id, this.#open({ id, userRef: params.userRef, token })]));
  }

  deleteToken(params: OAuthTokenKey, transaction?: TTransaction): Promise<void> {
    return this.#store.deleteToken(params, transaction);
  }

  deleteTokensForServer(params: { id: string }, transaction?: TTransaction): Promise<void> {
    return this.#store.deleteTokensForServer(params, transaction);
  }

  deletePendingAuthorizationsForServer(params: { id: string }, transaction?: TTransaction): Promise<void> {
    return this.#store.deletePendingAuthorizationsForServer(params, transaction);
  }

  #open({ id, userRef, token }: OAuthTokenKey & { token: OAuthToken }): OAuthToken {
    const open = ({ value, field }: { value: string; field: string }): string =>
      isEncryptedSecret(value) ? this.#vault.decrypt({ value, context: tokenContext({ id, userRef, field }) }) : value;
    return {
      ...token,
      accessToken: open({ value: token.accessToken, field: 'token.accessToken' }),
      refreshToken:
        token.refreshToken === null ? null : open({ value: token.refreshToken, field: 'token.refreshToken' }),
    };
  }
}
