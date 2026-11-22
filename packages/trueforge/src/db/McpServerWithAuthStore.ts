import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core';
import { isMcpAuthRequired, resolveMcpAuth, revokeMcpTokens } from '../mcp/auth/mcpDcr';
import type { IOAuthTokenStore, OAuthClientRecord } from '../mcp/auth/types';
import { resolveConfiguredMcpRequestHeaders, resolveMcpAuthStatus, type McpAuthStatus } from '../schemas/mcpServer';
import {
  McpServerNotFoundError,
  type AuthorizeMcpServerInput,
  type CreateMcpServerInput,
  type DeleteMcpAuthorizationInput,
  type DeleteMcpServerInput,
  type GetMcpServerInput,
  type IMcpServerStore,
  type IMcpServerWithAuthStore,
  type ListMcpServersInput,
  type McpServerRecord,
  type ResolveMcpAuthStatusesInput,
  type UpsertMcpServerInput,
} from './mcpServerStore';

export class McpServerWithAuthStore<TTransaction = never> implements IMcpServerWithAuthStore<TTransaction> {
  readonly #store: IMcpServerStore<TTransaction>;
  readonly #tokenStore: IOAuthTokenStore<TTransaction>;
  readonly #clientName: string;

  constructor(input: {
    store: IMcpServerStore<TTransaction>;
    tokenStore: IOAuthTokenStore<TTransaction>;
    clientName: string;
  }) {
    this.#store = input.store;
    this.#tokenStore = input.tokenStore;
    this.#clientName = input.clientName;
  }

  listServers(input: ListMcpServersInput, transaction?: TTransaction): Promise<McpServerRecord[]> {
    return this.#store.listServers(input, transaction);
  }

  getServer(input: GetMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord | undefined> {
    return this.#store.getServer(input, transaction);
  }

  getServerForUpdate(input: GetMcpServerInput, transaction: TTransaction): Promise<McpServerRecord | undefined> {
    return this.#store.getServerForUpdate(input, transaction);
  }

  createServer(input: CreateMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord> {
    return this.#store.createServer(input, transaction);
  }

  upsertServer(input: UpsertMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord> {
    return this.#store.upsertServer(input, transaction);
  }

  deleteServer(input: DeleteMcpServerInput, transaction?: TTransaction): Promise<boolean> {
    return this.#store.deleteServer(input, transaction);
  }

  resolveInvokeHeaders(input: { record: McpServerRecord; userRef: string }): RemoteMcpHeaders {
    const { record, userRef } = input;
    const auth = record.manifest.auth;
    if (auth?.type === 'dcr' || auth?.type === 'oauth_client') {
      const oauthParams =
        auth.type === 'oauth_client' ? { oauthClientId: auth.client_id, oauthClientSecret: auth.client_secret } : {};
      return async challenge => {
        const result = await resolveMcpAuth({
          tokenStore: this.#tokenStore,
          mcpServerStore: this.#store,
          serverId: record.id,
          userRef,
          mcpServerUrl: record.manifest.url,
          mcpServerName: record.name,
          clientName: this.#clientName,
          authType: auth.type,
          forceRefresh: challenge !== undefined,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          scope: auth.type === 'oauth_client' && auth.scopes?.length ? auth.scopes.join(' ') : challenge?.scope,
          ...oauthParams,
        });
        if (isMcpAuthRequired(result)) {
          // Wire `id` must match RemoteMCP.id (AgentSpec name), not the DB row ULID.
          return {
            authRequired: {
              servers: [{ id: record.name, name: record.name, auth_url: result.authUrl.href }],
            },
          };
        }
        return { headers: result.headers };
      };
    }
    return resolveConfiguredMcpRequestHeaders(record.manifest);
  }

  saveClient(params: { id: string; record: OAuthClientRecord }, transaction?: TTransaction): Promise<void> {
    return this.#store.saveClient(params, transaction);
  }

  getClient(params: { id: string }, transaction?: TTransaction): Promise<OAuthClientRecord | undefined> {
    return this.#store.getClient(params, transaction);
  }

  deleteClient(params: { id: string }, transaction?: TTransaction): Promise<void> {
    return this.#store.deleteClient(params, transaction);
  }

  async resolveAuthStatuses(input: ResolveMcpAuthStatusesInput): Promise<ReadonlyMap<string, McpAuthStatus>> {
    // `oauth_client` (fork-only; see DIVERGENCE.md) is token-backed the same way `dcr` is.
    const tokenBackedIds = input.records
      .filter(record => record.manifest.auth?.type !== 'header')
      .map(record => record.id);
    const tokens = await this.#tokenStore.getTokens({ ids: tokenBackedIds, userRef: input.userRef });
    const out = new Map<string, McpAuthStatus>();
    for (const record of input.records) {
      const token = tokens.get(record.id);
      if (
        record.manifest.type === 'remote' &&
        record.manifest.auth === undefined &&
        (await this.#store.getClient({ id: record.id })) !== undefined
      ) {
        out.set(record.name, token ? { status: 'authenticated' } : { status: 'auth_required' });
        continue;
      }
      out.set(
        record.name,
        resolveMcpAuthStatus({
          manifest: record.manifest,
          ...(token !== undefined ? { token } : {}),
        }),
      );
    }
    return out;
  }

  async authorize(input: AuthorizeMcpServerInput): Promise<McpAuthStatus> {
    const record = await this.#store.getServer({ tenant_id: input.tenant_id, name: input.name });
    if (record === undefined) {
      throw new McpServerNotFoundError(input.name);
    }
    const auth = record.manifest.auth;
    if (auth?.type !== 'dcr' && auth?.type !== 'oauth_client') {
      if (
        auth !== undefined ||
        record.manifest.type !== 'remote' ||
        (await this.#store.getClient({ id: record.id })) === undefined
      ) {
        return resolveMcpAuthStatus({ manifest: record.manifest });
      }
    }
    // `oauth_client` (fork-only; see DIVERGENCE.md) reuses the same discovery/token flow as `dcr`
    // but never registers a client: it is built from the manifest's own client_id/client_secret.
    const oauthParams =
      auth?.type === 'oauth_client' ? { oauthClientId: auth.client_id, oauthClientSecret: auth.client_secret } : {};
    const result = await resolveMcpAuth({
      tokenStore: this.#tokenStore,
      mcpServerStore: this.#store,
      serverId: record.id,
      userRef: input.userRef,
      mcpServerUrl: record.manifest.url,
      mcpServerName: record.name,
      clientName: this.#clientName,
      authType: auth?.type === 'oauth_client' ? 'oauth_client' : 'dcr',
      scope: auth?.type === 'oauth_client' && auth.scopes?.length ? auth.scopes.join(' ') : undefined,
      ...oauthParams,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
    });
    return isMcpAuthRequired(result)
      ? { status: 'auth_required', authorization_url: result.authUrl.href }
      : { status: 'authenticated' };
  }

  async deleteAuthorization(input: DeleteMcpAuthorizationInput): Promise<void> {
    const record = await this.#store.getServer({ tenant_id: input.tenant_id, name: input.name });
    if (record === undefined) {
      throw new McpServerNotFoundError(input.name);
    }
    const key = { id: record.id, userRef: input.userRef };
    const token = await this.#tokenStore.getToken(key);
    const client = token ? await this.#store.getClient({ id: record.id }) : undefined;
    try {
      if (client && token) {
        await revokeMcpTokens({ client, accessToken: token.accessToken, refreshToken: token.refreshToken });
      }
    } finally {
      await this.#tokenStore.deleteToken(key);
    }
  }
}
