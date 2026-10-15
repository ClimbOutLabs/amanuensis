import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  type Configuration,
  discovery,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { Logger } from 'winston';
import { getPublicBaseUrl, isPrivateNetworkHost, type OIDCConfig } from '../config';
import { buildAuthorizationRequestParams, type IdTokenClaims } from './claims';
import { ID_TOKEN_COOKIE, OAUTH_STATE_COOKIE, setAuthCookie } from './cookies';
import { assertEmailAllowed } from './emailAllowlist';
import { safeReturnTo } from './safeReturnTo';

const CALLBACK_PATH = '/api/v1/auth/callback';
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const ID_TOKEN_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/** JWKS + claim config used by cookie JWT verification when auth is enabled. */
export interface OidcVerify {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  oidcConfig: OIDCConfig;
}

/** Single instance of the OIDC verification. */
let oidcVerify: OidcVerify | null = null;

/** Enable cookie JWT verification using the IdP client + claim-mapping config from `initOidc`. */
export function enableOidcAuth(params: { client: Configuration; oidcConfig: OIDCConfig }): void {
  const metadata = params.client.serverMetadata();
  if (!metadata.jwks_uri) {
    throw new Error('OIDC discovery did not return jwks_uri; cannot verify ID tokens');
  }

  oidcVerify = {
    jwks: createRemoteJWKSet(new URL(metadata.jwks_uri)),
    issuer: metadata.issuer,
    audience: params.client.clientMetadata().client_id,
    oidcConfig: params.oidcConfig,
  };
}

/** Disable OIDC cookie auth (no IdP / standalone). Protected routes use the default user context. */
export function disableOidcAuth(): void {
  oidcVerify = null;
}

/** Active verification config, or `null` when auth is disabled. */
export function getOidcVerify(): OidcVerify | null {
  return oidcVerify;
}

/** Discover the IdP once at process startup when auth is enabled; wires cookie auth verification. */
export async function initOidc(oidc: OIDCConfig | undefined): Promise<Configuration | undefined> {
  if (!oidc) {
    disableOidcAuth();
    return undefined;
  }

  const issuer = new URL(oidc.OIDC_ISSUER_URL);
  // Config load already limited http issuers to this computer and private networks; every other issuer stays https-only.
  const client = await discovery(
    issuer,
    oidc.OIDC_CLIENT_ID,
    oidc.OIDC_CLIENT_SECRET,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only opt-in for a loopback http issuer
    issuer.protocol === 'http:' ? { execute: [allowInsecureRequests] } : undefined,
  );
  enableOidcAuth({ client, oidcConfig: oidc });
  return client;
}

const DISCOVERY_INITIAL_DELAY_MS = 2_000;
const DISCOVERY_MAX_DELAY_MS = 60_000;

/** Wait before retry number `attempt` (1-based): 2 s, doubling, capped at 60 s. */
export function discoveryRetryDelayMs(attempt: number): number {
  return Math.min(DISCOVERY_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt - 1), DISCOVERY_MAX_DELAY_MS);
}

/** Background discovery state: the client is undefined until discovery succeeds. */
export interface OidcDiscoveryHandle {
  client(): Configuration | undefined;
  stop(): void;
}

/**
 * Discover the IdP without blocking boot, retrying with capped backoff until it answers.
 * Until then protected routes stay 401 (no verifier) and login serves a retry page.
 */
export function startOidcDiscovery(params: { oidc: OIDCConfig; logger: Logger }): OidcDiscoveryHandle {
  const { oidc, logger } = params;
  let discovered: Configuration | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let attempt = 0;

  const attemptDiscovery = async (): Promise<void> => {
    attempt += 1;
    try {
      discovered = await initOidc(oidc);
      logger.info('OIDC discovery succeeded', { issuer: oidc.OIDC_ISSUER_URL, attempt });
    } catch (error) {
      const retryInMs = discoveryRetryDelayMs(attempt);
      logger.warn('OIDC discovery failed; retrying', {
        issuer: oidc.OIDC_ISSUER_URL,
        attempt,
        retry_in_ms: retryInMs,
        ...extractErrorLogFields(error),
      });
      if (!stopped) {
        timer = setTimeout(() => void attemptDiscovery(), retryInMs);
        timer.unref();
      }
    }
  };
  void attemptDiscovery();

  return {
    client: () => discovered,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Where the browser comes back after signing in. Normally the public address. An instance opened on the local network
 * is also opened at 127.0.0.1 or localhost on the same port; signing in there must return there, or the sign-in
 * cookies (set per host) would not be sent back. Only those two names are used, since only they are registered with
 * the IdP, and the request guard has already checked the Host header.
 */
function authCallbackUrl(context: Context): string {
  const publicBaseUrl = getPublicBaseUrl();
  const publicUrl = new URL(publicBaseUrl);
  if (isPrivateNetworkHost(publicUrl.hostname)) {
    const requestUrl = new URL(context.req.url);
    if (
      (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost') &&
      requestUrl.port === publicUrl.port &&
      requestUrl.protocol === publicUrl.protocol
    ) {
      return `${requestUrl.protocol}//${requestUrl.host}${CALLBACK_PATH}`;
    }
  }
  return `${publicBaseUrl}${CALLBACK_PATH}`;
}

export async function buildLoginAuthorization(params: {
  context: Context;
  client: Configuration;
  returnTo: string | undefined;
}): Promise<string> {
  const oidcConfig = getOidcVerify()?.oidcConfig;
  if (!oidcConfig) {
    throw new Error(
      'OIDC claim configuration is unavailable; call initOidc before building a login authorization URL.',
    );
  }

  const { scopes, claims } = buildAuthorizationRequestParams(oidcConfig);
  const returnTo = safeReturnTo(params.returnTo);
  const codeVerifier = randomPKCECodeVerifier();
  const state = randomState();
  const authorizationUrl = buildAuthorizationUrl(params.client, {
    redirect_uri: authCallbackUrl(params.context),
    scope: scopes.join(' '),
    claims: JSON.stringify(claims),
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
  });
  setAuthCookie({
    context: params.context,
    name: OAUTH_STATE_COOKIE,
    value: JSON.stringify({
      state,
      code_verifier: codeVerifier,
      return_to: returnTo,
    }),
    maxAgeSeconds: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return authorizationUrl.href;
}

export async function exchangeAuthorizationCode(params: {
  context: Context;
  client: Configuration;
  /** Whole IdP response query: openid-client validates `state`, `error` and `iss` from it. */
  callbackParams: URLSearchParams;
  codeVerifier: string;
  state: string;
}): Promise<void> {
  // The origin is one the login started on, so redirect_uri matches the one sent then and registered with the IdP.
  const callbackUrl = new URL(authCallbackUrl(params.context));
  callbackUrl.search = params.callbackParams.toString();
  const oidcConfig = getOidcVerify()?.oidcConfig;
  if (!oidcConfig) {
    throw new Error('OIDC claim configuration is unavailable; call initOidc before exchanging an authorization code.');
  }

  const tokens = await authorizationCodeGrant(params.client, callbackUrl, {
    pkceCodeVerifier: params.codeVerifier,
    expectedState: params.state,
  });
  const idToken = tokens.id_token;
  if (!idToken) {
    throw new Error('Token response missing id_token');
  }

  // Reject before stamping the cookie so disallowed users never get a session.
  const tokenClaims = tokens.claims();
  const claims: IdTokenClaims = tokenClaims ? { ...tokenClaims } : {};
  assertEmailAllowed(claims, oidcConfig);

  setAuthCookie({
    context: params.context,
    name: ID_TOKEN_COOKIE,
    value: idToken,
    maxAgeSeconds: ID_TOKEN_COOKIE_MAX_AGE_SECONDS,
  });
}
