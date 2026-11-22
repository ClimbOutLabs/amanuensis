import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidClientError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpConnectionError,
  McpDcrConfigurationError,
  OutboundRedirectRefusedError,
  withCheckedRedirects,
} from '@truefoundry/trueforge-core/core';
import { generateOAuthState } from '@truefoundry/trueforge-core/core/util/oauthState';
import { remoteUrlProblem, type RemoteUrlProblem } from '../../runtime/remoteAddress';
import {
  isOAuthAccessTokenUsable,
  mcpAuthorizationServerMetadata,
  mcpAuthorizationServerOrigin,
  mcpClientInformation,
  mcpOAuthCallbackUrl,
  mcpOAuthRedirectUris,
  oauthTokensToOAuthToken,
} from './mcpOAuthHelpers';
import type {
  IOAuthClientStore,
  IOAuthTokenStore,
  McpAuthRequiredResult,
  OAuthClientRecord,
  OAuthPendingAuthorization,
  ResolveMcpAuthResult,
} from './types';

/** Per-request timeout for MCP OAuth discovery, DCR, and token HTTP calls. */
export const MCP_OAUTH_HTTP_TIMEOUT_MS = 15_000;

/**
 * A sign-in dial was stopped by the address check (see runtime/remoteAddress): the address the
 * remote server named for discovery, registration, or the token call is one the server may not
 * connect to, or could not be checked. Rides on McpConnectionError under its own class so the
 * flows' error wrapping leaves its message, which already says what happened, as the answer.
 */
export class McpOAuthAddressRefusedError extends McpConnectionError {
  constructor(problem: RemoteUrlProblem | 'redirect' | 'bad-redirect' | 'post-redirect') {
    super(
      problem === 'blocked'
        ? "Sign-in stopped. The address this connector's server named for sign-in is one the server may not connect to. Use a connector whose sign-in address is on the internet or your home network."
        : problem === 'unresolved'
          ? "Sign-in stopped. The address this connector's server named for sign-in did not resolve, so the server cannot check it. Try again, or check the connector's address in Settings."
          : problem === 'invalid'
            ? "Sign-in stopped. The address this connector's server named for sign-in is not a full http or https address."
            : problem === 'post-redirect'
              ? 'Sign-in stopped because the sign-in server redirected a request containing credentials. Check the connector settings.'
              : problem === 'bad-redirect'
                ? 'Sign-in stopped. The sign-in address answered with a redirect that does not name an http or https address.'
                : 'Sign-in stopped. The sign-in address kept redirecting.',
      422,
    );
    this.name = 'McpOAuthAddressRefusedError';
  }
}

/**
 * One sign-in dial, behind the address check: the address is judged before it is connected to,
 * and redirects are followed through the core checked redirect loop (withCheckedRedirects),
 * which puts every hop to the same check before dialling it and takes the caller's credential
 * headers off a hop to another origin. The endpoints dialed here are named by the remote
 * server (its discovery answer names the authorization server, whose metadata names the
 * registration and token endpoints), so the checks at save and connect time, which judge the
 * address the person entered, cannot cover them. A refusal the loop reports in its own terms
 * is restated in this flow's: a chain that never ends, or a redirect that names no usable
 * address. Exported so tests can drive a single dial.
 */
export async function dialMcpOAuthUrl(url: string | URL, init: RequestInit): Promise<Response> {
  const start = new URL(url);
  if (start.protocol !== 'https:') {
    throw new McpConnectionError('Sign-in requires a secure service address. Check the connector settings.', 422);
  }
  const startProblem = await remoteUrlProblem({ url: start.href });
  if (startProblem !== null) {
    throw new McpOAuthAddressRefusedError(startProblem);
  }
  const checkedFetch = withCheckedRedirects(
    async (input, hopInit) => {
      const response = await fetch(input, hopInit);
      if (
        hopInit?.method !== undefined &&
        hopInit.method.toUpperCase() !== 'GET' &&
        response.status >= 300 &&
        response.status < 400
      ) {
        await response.body?.cancel();
        throw new McpOAuthAddressRefusedError('post-redirect');
      }
      return response;
    },
    async target => {
      if (new URL(target).protocol !== 'https:') {
        throw new McpConnectionError('Sign-in requires a secure service address. Check the connector settings.', 422);
      }
      const problem = await remoteUrlProblem({ url: target });
      if (problem !== null) {
        throw new McpOAuthAddressRefusedError(problem);
      }
      return true;
    },
  );
  try {
    return await checkedFetch(start, init);
  } catch (error) {
    if (error instanceof OutboundRedirectRefusedError) {
      throw new McpOAuthAddressRefusedError(error.kind === 'too-many' ? 'redirect' : 'bad-redirect');
    }
    throw error;
  }
}

/**
 * Abort hung authorization-server HTTP. Merges with any caller `signal` so both can cancel the request.
 * Used by discoverOAuthServerInfo / registerClient / refreshAuthorization / exchangeAuthorization
 * (startAuthorization is local PKCE + URL construction and never calls this).
 */
const mcpOAuthFetch: FetchLike = (url, init) => {
  const timeoutSignal = AbortSignal.timeout(MCP_OAUTH_HTTP_TIMEOUT_MS);
  const signal = init?.signal != null ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return dialMcpOAuthUrl(url, { ...init, signal });
};

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** Same status as non-timeout faults; appends a timeout note so the API body is actionable. */
function mcpOAuthConnectionError(message: string, error: unknown, statusCode: number): McpConnectionError {
  let body = message;
  if (isTimeoutError(error)) {
    body = `${message}: timed out after ${String(MCP_OAUTH_HTTP_TIMEOUT_MS / 1000)}s waiting for the authorization server`;
  }
  return new McpConnectionError(body, statusCode, { cause: error });
}

async function discoverMcpServerInfo(params: { mcpServerUrl: string; resourceMetadataUrl?: string | undefined }) {
  const { mcpServerUrl, resourceMetadataUrl } = params;
  // Do not treat malformed or unreachable metadata as an invitation to trust another issuer.
  let resourceMetadata;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      mcpServerUrl,
      { ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}) },
      mcpOAuthFetch,
    );
  } catch (error) {
    if (
      resourceMetadataUrl !== undefined ||
      !(error instanceof Error) ||
      error.message !== 'Resource server does not implement OAuth 2.0 Protected Resource Metadata.'
    ) {
      throw error;
    }
  }
  if (resourceMetadata) {
    if (
      !checkResourceAllowed({
        requestedResource: resourceUrlFromServerUrl(mcpServerUrl),
        configuredResource: resourceMetadata.resource,
      })
    ) {
      throw new Error('Protected resource does not match the connector address');
    }
  }
  const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL('/', mcpServerUrl));
  const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
    fetchFn: mcpOAuthFetch,
  });
  if (
    authorizationServerMetadata &&
    new URL(authorizationServerMetadata.authorization_endpoint).protocol !== 'https:'
  ) {
    throw new Error('Authorization endpoint must use HTTPS');
  }
  if (authorizationServerMetadata) {
    const problem = await remoteUrlProblem({ url: authorizationServerMetadata.authorization_endpoint });
    if (problem !== null) {
      throw new McpOAuthAddressRefusedError(problem);
    }
  }
  if (authorizationServerMetadata && authorizationServerMetadata.issuer !== authorizationServerUrl) {
    throw new Error('Authorization server issuer does not match its discovery address');
  }
  return { authorizationServerUrl, authorizationServerMetadata, resourceMetadata };
}

export function isMcpAuthRequired(result: ResolveMcpAuthResult): result is McpAuthRequiredResult {
  return 'authUrl' in result;
}

function revocationMetadata(metadata: AuthorizationServerMetadata): OAuthClientRecord['server']['revocation'] {
  const endpoint: unknown = Reflect.get(metadata, 'revocation_endpoint');
  if (typeof endpoint !== 'string') {
    return null;
  }
  const methods: unknown = Reflect.get(metadata, 'revocation_endpoint_auth_methods_supported');
  return {
    endpoint,
    authMethods: Array.isArray(methods) && methods.every(method => typeof method === 'string') ? methods : null,
  };
}

async function registerMcpClientWithAuthMethodFallback(params: {
  authorizationServerUrl: string;
  resource: string | null;
  metadata: AuthorizationServerMetadata;
  clientMetadata: OAuthClientMetadata;
  mcpServerName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}): Promise<OAuthClientRecord> {
  const { authorizationServerUrl, metadata, clientMetadata, mcpServerName, authorizationEndpoint, tokenEndpoint } =
    params;
  const methods = metadata.token_endpoint_auth_methods_supported;
  const requestedMethod = methods?.includes('client_secret_post')
    ? 'client_secret_post'
    : methods?.includes('none')
      ? 'none'
      : 'client_secret_basic';
  let fullInfo;
  let fallback = false;
  try {
    fullInfo = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: {
        ...clientMetadata,
        token_endpoint_auth_method: requestedMethod,
      },
      fetchFn: mcpOAuthFetch,
    });
  } catch (firstError: unknown) {
    if (firstError instanceof McpOAuthAddressRefusedError) {
      throw firstError;
    }
    if (!(firstError instanceof InvalidClientMetadataError)) {
      throw mcpOAuthConnectionError(
        `Failed to dynamically register OAuth client for MCP server '${mcpServerName}'`,
        firstError,
        424,
      );
    }
    try {
      fallback = true;
      fullInfo = await registerClient(authorizationServerUrl, {
        metadata,
        clientMetadata,
        fetchFn: mcpOAuthFetch,
      });
    } catch (secondError: unknown) {
      if (secondError instanceof McpOAuthAddressRefusedError) {
        throw secondError;
      }
      throw mcpOAuthConnectionError(
        `Failed to dynamically register OAuth client for MCP server '${mcpServerName}'`,
        secondError,
        424,
      );
    }
  }
  if (!fullInfo.client_id) {
    throw new McpConnectionError(
      `Authorization server for MCP server '${mcpServerName}' returned a client response without client_id`,
      424,
    );
  }
  const method =
    fullInfo.token_endpoint_auth_method ??
    (fullInfo.client_secret ? (fallback ? 'client_secret_basic' : requestedMethod) : 'none');
  if (method !== 'none' && method !== 'client_secret_basic' && method !== 'client_secret_post') {
    throw new McpDcrConfigurationError('The service requires a sign-in method Aman does not support.');
  }
  if (method !== 'none' && !fullInfo.client_secret) {
    throw new McpDcrConfigurationError('The service did not provide its sign-in secret. Try connecting again.');
  }
  return {
    server: {
      issuer: metadata.issuer,
      issuerResponseRequired: Reflect.get(metadata, 'authorization_response_iss_parameter_supported') === true,
      resource: params.resource,
      revocation: revocationMetadata(metadata),
      authorizationEndpoint,
      tokenEndpoint,
      codeChallengeMethodsSupported: metadata.code_challenge_methods_supported ?? null,
    },
    client: {
      clientId: fullInfo.client_id,
      clientSecret: fullInfo.client_secret ?? null,
      tokenAuthMethod: method,
    },
  };
}

/**
 * Discovers the MCP server's authorization server and validates S256 PKCE support.
 * Returns AS endpoints for both DCR and oauth_client flows.
 */
async function discoverMcpAuthorizationServerMetadata(params: {
  mcpServerUrl: string;
  mcpServerName: string;
  resourceMetadataUrl?: string | undefined;
}): Promise<{
  issuer: string | null;
  issuerResponseRequired: boolean;
  resource: string | null;
  revocation: { endpoint: string; authMethods: string[] | null } | null;
  tokenAuthMethods: string[] | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  codeChallengeMethodsSupported: string[] | null;
}> {
  const { mcpServerUrl, mcpServerName } = params;
  let discovered: Awaited<ReturnType<typeof discoverMcpServerInfo>>;
  try {
    discovered = await discoverMcpServerInfo({ mcpServerUrl, resourceMetadataUrl: params.resourceMetadataUrl });
  } catch (error: unknown) {
    if (error instanceof McpOAuthAddressRefusedError) {
      throw error;
    }
    throw mcpOAuthConnectionError(
      `Failed to discover OAuth authorization server for MCP server '${mcpServerName}'`,
      error,
      424,
    );
  }
  const { authorizationServerMetadata: metadata } = discovered;
  if (!metadata) {
    throw new McpDcrConfigurationError(
      `Authorization server for MCP server '${mcpServerName}' did not provide metadata`,
    );
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new McpDcrConfigurationError(
      `Authorization server for MCP server '${mcpServerName}' is missing authorization_endpoint or token_endpoint`,
    );
  }
  const pkceMethods = metadata.code_challenge_methods_supported;
  if (pkceMethods && !pkceMethods.includes('S256')) {
    throw new McpDcrConfigurationError(
      `Authorization server for MCP server '${mcpServerName}' advertises PKCE methods without S256`,
    );
  }
  return {
    issuer: metadata.issuer,
    issuerResponseRequired: Reflect.get(metadata, 'authorization_response_iss_parameter_supported') === true,
    resource: discovered.resourceMetadata?.resource ?? null,
    revocation: revocationMetadata(metadata),
    tokenAuthMethods: metadata.token_endpoint_auth_methods_supported ?? null,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    codeChallengeMethodsSupported: pkceMethods ?? null,
  };
}

/**
 * Discovers the MCP server's authorization server, validates DCR + S256 PKCE support, and
 * registers a new OAuth client (RFC 7591). Returns AS endpoints + client credentials for the
 * caller to persist; does not write to the store.
 */
export async function createMcpOAuthClient(params: {
  mcpServerUrl: string;
  mcpServerName: string;
  /** Registered together; the first is the one this request uses. */
  redirectUris: string[];
  clientName: string;
  resourceMetadataUrl?: string | undefined;
}): Promise<OAuthClientRecord> {
  const { mcpServerUrl, mcpServerName, redirectUris, clientName } = params;
  let discovered: Awaited<ReturnType<typeof discoverMcpServerInfo>>;
  try {
    discovered = await discoverMcpServerInfo({ mcpServerUrl, resourceMetadataUrl: params.resourceMetadataUrl });
  } catch (error: unknown) {
    if (error instanceof McpOAuthAddressRefusedError) {
      throw error;
    }
    throw mcpOAuthConnectionError(
      `Failed to discover OAuth authorization server for MCP server '${mcpServerName}'`,
      error,
      424,
    );
  }
  const { authorizationServerUrl, authorizationServerMetadata: metadata } = discovered;
  if (!metadata?.registration_endpoint) {
    throw new McpDcrConfigurationError(
      `MCP server '${mcpServerName}' has no DCR support (missing registration_endpoint); auth.type: dcr is misconfigured for this server`,
    );
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new McpDcrConfigurationError(
      `Authorization server for MCP server '${mcpServerName}' is missing authorization_endpoint or token_endpoint`,
    );
  }
  const pkceMethods = metadata.code_challenge_methods_supported;
  if (pkceMethods && !pkceMethods.includes('S256')) {
    throw new McpDcrConfigurationError(
      `Authorization server for MCP server '${mcpServerName}' advertises PKCE methods without S256`,
    );
  }
  const register = (uris: string[]): Promise<OAuthClientRecord> =>
    registerMcpClientWithAuthMethodFallback({
      authorizationServerUrl,
      resource: discovered.resourceMetadata?.resource ?? null,
      metadata,
      clientMetadata: {
        client_name: clientName,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      mcpServerName,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
    });
  const [first] = redirectUris;
  if (first === undefined) {
    throw new McpDcrConfigurationError(`No OAuth callback address for MCP server '${mcpServerName}'`);
  }
  try {
    return await register(redirectUris);
  } catch (error: unknown) {
    // A server that refuses some of the addresses (for example plain http ones) still gets this request's own.
    if (redirectUris.length === 1) {
      throw error;
    }
    return register([first]);
  }
}

/**
 * Builds a client record from pre-registered OAuth credentials in the manifest.
 * Discovers the authorization server metadata but does not register a new client.
 */
async function createMcpOAuthClientFromManifest(params: {
  clientId: string;
  clientSecret: string;
  mcpServerUrl: string;
  mcpServerName: string;
  resourceMetadataUrl?: string | undefined;
}): Promise<OAuthClientRecord> {
  const metadata = await discoverMcpAuthorizationServerMetadata({
    mcpServerUrl: params.mcpServerUrl,
    mcpServerName: params.mcpServerName,
    resourceMetadataUrl: params.resourceMetadataUrl,
  });
  const tokenAuthMethod = metadata.tokenAuthMethods?.includes('client_secret_post')
    ? 'client_secret_post'
    : 'client_secret_basic';
  if (metadata.tokenAuthMethods !== null && !metadata.tokenAuthMethods.includes(tokenAuthMethod)) {
    throw new McpDcrConfigurationError(
      'The service does not support the configured sign-in method. Check the connector settings.',
    );
  }
  return {
    server: {
      issuer: metadata.issuer,
      issuerResponseRequired: metadata.issuerResponseRequired,
      resource: metadata.resource,
      revocation: metadata.revocation,
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      codeChallengeMethodsSupported: metadata.codeChallengeMethodsSupported,
    },
    client: {
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      tokenAuthMethod,
    },
  };
}

/**
 * Returns the stored OAuth client for `serverId`, or discovers + creates one via DCR or oauth_client.
 * For DCR: discovers + registers and persists a new client.
 * For oauth_client: stores the configured credentials for the callback.
 * Used from `resolveMcpAuth` only — callers that already hold the client should pass it through.
 */
export async function ensureMcpClientRegistered(params: {
  mcpServerStore: IOAuthClientStore;
  serverId: string;
  mcpServerUrl: string;
  mcpServerName: string;
  clientName: string;
  authType: 'dcr' | 'oauth_client';
  resourceMetadataUrl?: string | undefined;
  oauthClientId?: string | undefined;
  oauthClientSecret?: string | undefined;
}): Promise<OAuthClientRecord> {
  const existing = await params.mcpServerStore.getClient({ id: params.serverId });
  if (
    existing &&
    (params.authType === 'dcr' ||
      (existing.client.clientId === params.oauthClientId && existing.client.clientSecret === params.oauthClientSecret))
  ) {
    return existing;
  }
  if (params.authType === 'oauth_client') {
    if (!params.oauthClientId || !params.oauthClientSecret) {
      throw new McpConnectionError(
        `OAuth client auth requires client_id and client_secret for MCP server '${params.mcpServerName}'`,
        400,
      );
    }
    const client = await createMcpOAuthClientFromManifest({
      clientId: params.oauthClientId,
      clientSecret: params.oauthClientSecret,
      mcpServerUrl: params.mcpServerUrl,
      mcpServerName: params.mcpServerName,
      resourceMetadataUrl: params.resourceMetadataUrl,
    });
    await params.mcpServerStore.saveClient({ id: params.serverId, record: client });
    return client;
  }
  const client = await createMcpOAuthClient({
    mcpServerUrl: params.mcpServerUrl,
    mcpServerName: params.mcpServerName,
    redirectUris: mcpOAuthRedirectUris(),
    clientName: params.clientName,
    resourceMetadataUrl: params.resourceMetadataUrl,
  });
  await params.mcpServerStore.saveClient({ id: params.serverId, record: client });
  return client;
}

/** Builds the AS authorize URL and saves the pending PKCE row. Caller must already have `client`. */
export async function buildMcpAuthorizationUrl(params: {
  tokenStore: IOAuthTokenStore;
  client: OAuthClientRecord;
  serverId: string;
  userRef: string;
  mcpServerUrl: string;
  mcpServerName: string;
  returnTo?: string;
  scope?: string | undefined;
}): Promise<{ authorizationUrl: URL; state: string }> {
  const state = generateOAuthState();
  const redirectUri = mcpOAuthCallbackUrl();
  let started: Awaited<ReturnType<typeof startAuthorization>>;
  try {
    started = await startAuthorization(mcpAuthorizationServerOrigin(params.client.server), {
      metadata: mcpAuthorizationServerMetadata(params.client.server),
      clientInformation: mcpClientInformation(params.client.client),
      redirectUrl: redirectUri,
      resource: params.client.server.resource ?? resourceUrlFromServerUrl(params.mcpServerUrl),
      state,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
    });
  } catch (error: unknown) {
    throw new McpConnectionError(`Failed to start OAuth authorization for MCP server '${params.mcpServerName}'`, 424, {
      cause: error,
    });
  }
  await params.tokenStore.savePendingAuthorization({
    state,
    id: params.serverId,
    userRef: params.userRef,
    mcpServerUrl: params.mcpServerUrl,
    codeVerifier: started.codeVerifier,
    redirectUri,
    returnTo: params.returnTo ?? null,
  });
  return { authorizationUrl: started.authorizationUrl, state };
}

export async function resolveMcpAuth(params: {
  tokenStore: IOAuthTokenStore;
  mcpServerStore: IOAuthClientStore;
  serverId: string;
  userRef: string;
  mcpServerUrl: string;
  mcpServerName: string;
  clientName: string;
  authType: 'dcr' | 'oauth_client';
  resourceMetadataUrl?: string | undefined;
  oauthClientId?: string;
  oauthClientSecret?: string;
  returnTo?: string;
  scope?: string | undefined;
  forceRefresh?: boolean | undefined;
}): Promise<ResolveMcpAuthResult> {
  const nowMs = Date.now();
  const tokenKey = { id: params.serverId, userRef: params.userRef };
  const token = await params.tokenStore.getToken(tokenKey);
  if (token && !params.forceRefresh && isOAuthAccessTokenUsable(token.expiresAt, nowMs)) {
    return { headers: { Authorization: `Bearer ${token.accessToken}` } };
  }
  const client = await ensureMcpClientRegistered({
    mcpServerStore: params.mcpServerStore,
    serverId: params.serverId,
    mcpServerUrl: params.mcpServerUrl,
    mcpServerName: params.mcpServerName,
    clientName: params.clientName,
    authType: params.authType,
    resourceMetadataUrl: params.resourceMetadataUrl,
    oauthClientId: params.oauthClientId,
    oauthClientSecret: params.oauthClientSecret,
  });
  if (token?.refreshToken) {
    try {
      const refreshed = await refreshAuthorization(mcpAuthorizationServerOrigin(client.server), {
        metadata: mcpAuthorizationServerMetadata(client.server),
        clientInformation: mcpClientInformation(client.client),
        refreshToken: token.refreshToken,
        resource: client.server.resource ?? resourceUrlFromServerUrl(params.mcpServerUrl),
        fetchFn: mcpOAuthFetch,
      });
      const saved = oauthTokensToOAuthToken(refreshed, nowMs, token.refreshToken);
      await params.tokenStore.saveToken({ ...tokenKey, token: saved });
      return { headers: { Authorization: `Bearer ${saved.accessToken}` } };
    } catch {
      // Refresh failure falls through to a fresh authorization.
    }
  }
  if (token) {
    await params.tokenStore.deleteToken(tokenKey);
  }
  const { authorizationUrl: authUrl } = await buildMcpAuthorizationUrl({
    tokenStore: params.tokenStore,
    client,
    serverId: params.serverId,
    userRef: params.userRef,
    mcpServerUrl: params.mcpServerUrl,
    mcpServerName: params.mcpServerName,
    scope: params.scope,
    ...(params.returnTo !== undefined ? { returnTo: params.returnTo } : {}),
  });
  return { authUrl };
}

/**
 * Exchanges `code` for tokens against an already-claimed `pending` row: the caller claims it with
 * `consumePendingAuthorization` so duplicate callbacks lose the race, and keeps it for its FE
 * landing URL. Route must already reject IdP `error` params. On `invalid_client`, clears the stored
 * client so the next authorize re-registers (per-user tokens are left; there is usually none yet).
 */
export async function completeMcpAuthorization<TTransaction>(params: {
  tokenStore: IOAuthTokenStore<TTransaction>;
  mcpServerStore: IOAuthClientStore<TTransaction>;
  pending: OAuthPendingAuthorization;
  code: string;
}): Promise<void> {
  const nowMs = Date.now();
  const { pending } = params;

  const client = await params.mcpServerStore.getClient({ id: pending.id });
  if (!client) {
    throw new McpConnectionError(
      `No OAuth client registered for MCP server id '${pending.id}'; re-run authorize first`,
      400,
    );
  }
  if (pending.codeVerifier === null) {
    throw new McpConnectionError('Pending authorization is missing PKCE code_verifier; re-run authorize', 400);
  }
  if (pending.redirectUri !== null && pending.redirectUri !== mcpOAuthCallbackUrl()) {
    throw new McpConnectionError('Sign-in returned to a different address. Start connecting again.', 400);
  }
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(mcpAuthorizationServerOrigin(client.server), {
      metadata: mcpAuthorizationServerMetadata(client.server),
      clientInformation: mcpClientInformation(client.client),
      authorizationCode: params.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri ?? mcpOAuthCallbackUrl(),
      resource: client.server.resource ?? resourceUrlFromServerUrl(pending.mcpServerUrl),
      fetchFn: mcpOAuthFetch,
    });
  } catch (error: unknown) {
    if (error instanceof McpOAuthAddressRefusedError) {
      throw error;
    }
    if (error instanceof InvalidClientError) {
      await params.mcpServerStore.deleteClient({ id: pending.id });
      throw new McpConnectionError('OAuth client registration is invalid; please retry connecting', 400, {
        cause: error,
      });
    }
    throw mcpOAuthConnectionError('OAuth token exchange failed', error, 400);
  }
  await params.tokenStore.saveToken({
    id: pending.id,
    userRef: pending.userRef,
    token: oauthTokensToOAuthToken(tokens, nowMs, null),
  });
}

/** Revoke the refresh and access tokens when the service publishes a revocation endpoint. */
export async function revokeMcpTokens(params: {
  client: OAuthClientRecord;
  accessToken: string;
  refreshToken: string | null;
}): Promise<void> {
  const revocation = params.client.server.revocation;
  if (revocation === null) {
    return;
  }
  const { clientId, clientSecret } = params.client.client;
  const methods = revocation.authMethods;
  const method =
    clientSecret === null
      ? 'none'
      : methods === null || methods.includes('client_secret_basic')
        ? 'client_secret_basic'
        : 'client_secret_post';
  if (methods !== null && !methods.includes(method)) {
    throw new McpConnectionError('Could not sign out at the service. Remove access in the service settings.', 424);
  }
  for (const [token, tokenType] of [
    [params.refreshToken, 'refresh_token'],
    [params.accessToken, 'access_token'],
  ]) {
    if (token === null || token === undefined) {
      continue;
    }
    const form = new URLSearchParams({ token, token_type_hint: tokenType ?? 'access_token' });
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (method === 'client_secret_basic' && clientSecret !== null) {
      const encode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`,
      );
    } else {
      form.set('client_id', clientId);
      if (method === 'client_secret_post' && clientSecret !== null) {
        form.set('client_secret', clientSecret);
      }
    }
    try {
      const response = await mcpOAuthFetch(revocation.endpoint, { method: 'POST', headers, body: form });
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error('revocation refused');
      }
    } catch (error) {
      throw new McpConnectionError('Could not sign out at the service. Remove access in the service settings.', 424, {
        cause: error,
      });
    }
  }
}
