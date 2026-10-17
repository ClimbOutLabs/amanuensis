import type { GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { isSecretReference, resolveSecretReference } from '../utils/secretReferences';

/** How long one user's secret list is reused; every classification of a single call lands inside it. */
const SECRET_CACHE_TTL_MS = 5_000;

export interface OutboundSecretSources {
  /** Secrets from the server's own configuration. */
  configured: () => readonly string[];
  modelProviders: Pick<IModelProviderStore, 'listProviders'>;
  sandboxProviders: Pick<ISandboxProviderStore, 'getSandboxProvider'>;
  mcpServers: Pick<IMcpServerStore, 'listServers' | 'getClient'>;
  tokens: Pick<IOAuthTokenStore, 'getTokens'>;
  /** The user's own Google login: its client secret and refresh token must never ride out in a call. */
  googleConnections: Pick<GoogleConnectionStore, 'get'>;
}

/** A stored value that is a `${env:...}` or `${file:...}` pointer stands for the value it resolves to. */
async function resolveStoredValue(value: string): Promise<string | undefined> {
  if (!isSecretReference(value)) {
    return value;
  }
  try {
    return await resolveSecretReference(value);
  } catch {
    // A pointer that no longer resolves holds no value to leak.
    return undefined;
  }
}

const AUTH_SCHEME = /^(bearer|basic|token)\s+(\S+)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A header value together with its bare credential, so a key sent without its scheme word is still
 * matched. A Basic credential also yields its decoded `user:password` and each half.
 */
function headerCredentialForms(value: string): string[] {
  const match = AUTH_SCHEME.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  const credential = match?.[2];
  if (scheme === undefined || credential === undefined) {
    return [value];
  }
  const forms = [value, credential];
  if (scheme === 'basic' && BASE64.test(credential)) {
    const decoded = Buffer.from(credential, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0 && !decoded.includes('\uFFFD')) {
      // RFC 7617 allows an empty user id (`:<token>`), so each half is kept only when present.
      const halves = [decoded.slice(0, separator), decoded.slice(separator + 1)].filter(half => half !== '');
      forms.push(decoded, ...halves);
    }
  }
  return forms;
}

async function collectSecrets(input: {
  sources: OutboundSecretSources;
  tenant_id: string;
  created_by: string;
}): Promise<string[]> {
  const { sources, tenant_id, created_by } = input;
  const [providers, sandbox, servers, google] = await Promise.all([
    sources.modelProviders.listProviders({ tenant_id }),
    sources.sandboxProviders.getSandboxProvider(tenant_id),
    sources.mcpServers.listServers({ tenant_id, names: undefined }),
    sources.googleConnections.get({ tenant_id, created_by }),
  ]);
  const raw: string[] = [...sources.configured()];
  const headerValues: string[] = [];
  if (google !== null) {
    raw.push(google.client_secret, google.refresh_token);
  }
  for (const provider of providers) {
    const apiKey = provider.manifest.auth?.api_key;
    if (apiKey !== undefined) {
      raw.push(apiKey);
    }
  }
  if (sandbox?.manifest.type === 'daytona') {
    raw.push(sandbox.manifest.auth.api_key);
  }
  for (const server of servers) {
    const auth = server.manifest.auth;
    if (auth?.type === 'header') {
      headerValues.push(...Object.values(auth.headers));
    } else if (auth?.type === 'oauth_client') {
      raw.push(auth.client_secret);
    }
  }
  const [tokens, clients] = await Promise.all([
    sources.tokens.getTokens({ ids: servers.map(server => server.id), userRef: created_by }),
    Promise.all(servers.map(server => sources.mcpServers.getClient({ id: server.id }))),
  ]);
  for (const token of tokens.values()) {
    raw.push(token.accessToken);
    if (token.refreshToken !== null) {
      raw.push(token.refreshToken);
    }
  }
  for (const client of clients) {
    if (client?.client.clientSecret !== null && client?.client.clientSecret !== undefined) {
      raw.push(client.client.clientSecret);
    }
  }
  const [resolved, resolvedHeaders] = await Promise.all([
    Promise.all(raw.map(resolveStoredValue)),
    Promise.all(headerValues.map(resolveStoredValue)),
  ]);
  const headerForms = resolvedHeaders.flatMap(value => (value === undefined ? [] : headerCredentialForms(value)));
  return [
    ...new Set([...resolved, ...headerForms].filter((value): value is string => value !== undefined && value !== '')),
  ];
}

/**
 * The exact secret values this server holds that a user's outbound call must never carry: model and
 * sandbox provider keys, connector headers, client secrets and OAuth tokens, the user's Google login, and configured
 * credentials. Read fresh from the stores (briefly cached per user), so a rotated key is covered
 * without a restart. A failing store rejects, so the caller treats the call as unchecked.
 */
export function createOutboundSecretSource(sources: OutboundSecretSources) {
  const cache = new Map<string, { expiresAt: number; secrets: Promise<string[]> }>();
  return async (owner: { tenant_id: string; created_by: string }): Promise<readonly string[]> => {
    const key = JSON.stringify([owner.tenant_id, owner.created_by]);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.secrets;
    }
    for (const [cachedKey, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(cachedKey);
      }
    }
    const secrets = collectSecrets({ sources, ...owner });
    cache.set(key, { expiresAt: now + SECRET_CACHE_TTL_MS, secrets });
    try {
      return await secrets;
    } catch (error) {
      cache.delete(key);
      throw new Error('Could not read the secrets this server holds', { cause: error });
    }
  };
}
