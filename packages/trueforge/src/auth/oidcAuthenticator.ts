import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { jwtVerify } from 'jose';

import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import type { Authenticator } from './authenticator';
import { toRequestContext, type IdTokenClaims } from './claims';
import type { RequestContext } from './identity';
import { getOidcVerify } from './oidc';
import { carriesTerminalKey, resolveTerminalKeyContext } from './terminalKey';
import { extractRequestToken } from './token';

export class OidcAuthenticator implements Authenticator {
  readonly #terminalKeyStore: ITerminalKeyStore | undefined;

  constructor(params?: { terminalKeyStore?: ITerminalKeyStore }) {
    this.#terminalKeyStore = params?.terminalKeyStore;
  }

  async authenticate(c: Context): Promise<RequestContext> {
    // A paired terminal key is a Bearer token of its own shape, checked against the
    // terminal key store before the token is read as a sign-in token. A terminal key
    // that is unknown or revoked signs nobody in.
    if (carriesTerminalKey(c)) {
      const terminalContext = await resolveTerminalKeyContext({ store: this.#terminalKeyStore, context: c });
      if (terminalContext === undefined) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }
      return terminalContext;
    }

    const oidcVerify = getOidcVerify();
    if (!oidcVerify) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    const token = extractRequestToken(c);
    if (!token) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      ({ payload } = await jwtVerify(token, oidcVerify.jwks, {
        issuer: oidcVerify.issuer,
        audience: oidcVerify.audience,
      }));
    } catch {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    try {
      const claims: IdTokenClaims = { ...payload };
      return toRequestContext({
        claims,
        config: oidcVerify.oidcConfig,
        user_credential: token,
      });
    } catch (error) {
      throw new HTTPException(401, { message: 'Authentication required', cause: error });
    }
  }
}
