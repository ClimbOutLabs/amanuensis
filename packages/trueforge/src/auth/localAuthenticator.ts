import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ILocalUserStore } from '../db/localUserStore';
import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import type { Authenticator } from './authenticator';
import { STANDALONE_ADMIN_ROLE, type RequestContext } from './identity';
import { getOrCreateLocalSessionSecret, verifyLocalSessionToken } from './localSession';
import { carriesTerminalKey, resolveTerminalKeyContext } from './terminalKey';
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
  readonly #terminalKeyStore: ITerminalKeyStore | undefined;
  readonly #logger: Logger | undefined;
  #secret: Promise<Uint8Array> | undefined;

  constructor(params: {
    localUserStore: ILocalUserStore;
    globalSettingsStore: IGlobalSettingsStore;
    terminalKeyStore?: ITerminalKeyStore;
    logger?: Logger;
  }) {
    this.#localUserStore = params.localUserStore;
    this.#globalSettingsStore = params.globalSettingsStore;
    this.#terminalKeyStore = params.terminalKeyStore;
    this.#logger = params.logger;
  }

  async authenticate(c: Context): Promise<RequestContext> {
    // A paired terminal key is a Bearer token of its own shape, checked against the
    // terminal key store before the token is read as a session token. A terminal key
    // that is unknown or revoked signs nobody in.
    if (carriesTerminalKey(c)) {
      const terminalContext = await resolveTerminalKeyContext({
        store: this.#terminalKeyStore,
        context: c,
        ...(this.#logger === undefined ? {} : { logger: this.#logger }),
      });
      if (terminalContext === undefined) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }
      return terminalContext;
    }
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
