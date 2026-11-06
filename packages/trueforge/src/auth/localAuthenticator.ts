import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ILocalUserStore } from '../db/localUserStore';
import type { Authenticator } from './authenticator';
import { STANDALONE_ADMIN_ROLE, type RequestContext } from './identity';
import { getOrCreateLocalSessionSecret, verifyLocalSessionToken } from './localSession';
import { extractRequestToken } from './token';

/**
 * Authenticates the one local user from the session token Aman issued at sign-in.
 * The token is checked against the stored user on every request: a password change
 * or reset raises the stored session version, and tokens issued under the old one
 * stop working at once.
 */
export class LocalAuthenticator implements Authenticator {
  readonly #localUserStore: ILocalUserStore;
  readonly #globalSettingsStore: IGlobalSettingsStore;
  #secret: Promise<Uint8Array> | undefined;

  constructor(params: { localUserStore: ILocalUserStore; globalSettingsStore: IGlobalSettingsStore }) {
    this.#localUserStore = params.localUserStore;
    this.#globalSettingsStore = params.globalSettingsStore;
  }

  async authenticate(c: Context): Promise<RequestContext> {
    const token = extractRequestToken(c);
    if (!token) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    this.#secret ??= getOrCreateLocalSessionSecret(this.#globalSettingsStore);
    const secret = await this.#secret;
    const claims = await verifyLocalSessionToken({ token, secret });
    if (claims === undefined) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    const user = await this.#localUserStore.getUser();
    if (user?.id !== claims.user_id || user.session_version !== claims.session_version) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    return {
      tenant_id: 'default',
      subject: {
        id: user.id,
        type: 'user',
        display_name: user.email,
      },
      roles: [STANDALONE_ADMIN_ROLE],
      user_credential: token,
    };
  }
}
