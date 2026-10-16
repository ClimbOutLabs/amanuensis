/**
 * Collects every stored secret value the export must never ship, for layer 1
 * of the export scrub (exact-match removal from every section). Sources:
 * model provider API keys, MCP connector header credentials and OAuth
 * client secrets, dynamically registered OAuth client secrets, and the
 * caller's own OAuth tokens for those connectors.
 *
 * Values are used only in memory, for substring removal; they are never
 * logged or written anywhere.
 */
import type { IMcpServerStore, McpServerRecord } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { normalizeSecrets } from './secretScrub';

export interface SecretCollectionDeps<TTransaction> {
  modelProviderStore: IModelProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  tenantId: string;
  /** The exporting user; OAuth tokens are per user. */
  subjectId: string;
}

function manifestSecrets(record: McpServerRecord, out: (string | null | undefined)[]): void {
  const auth = record.manifest.auth;
  if (auth === undefined) {
    return;
  }
  if (auth.type === 'header') {
    for (const value of Object.values(auth.headers)) {
      out.push(value);
      // A header value is often `Bearer <token>`: the bare token is what a
      // user pastes into a chat or a memory note, so collect the parts too.
      out.push(...value.split(/\s+/));
    }
  } else if (auth.type === 'oauth_client') {
    out.push(auth.client_secret);
  }
}

export async function collectStoredSecrets<TTransaction>(deps: SecretCollectionDeps<TTransaction>): Promise<string[]> {
  const values: (string | null | undefined)[] = [];

  const providers = await deps.modelProviderStore.listProviders({ tenant_id: deps.tenantId });
  for (const provider of providers) {
    values.push(provider.manifest.auth?.api_key);
  }

  const servers = await deps.mcpServerStore.listServers({ tenant_id: deps.tenantId, names: undefined });
  for (const server of servers) {
    manifestSecrets(server, values);
    const client = await deps.mcpServerStore.getClient({ id: server.id });
    values.push(client?.client.clientSecret);
  }

  if (servers.length > 0) {
    const tokens = await deps.tokenStore.getTokens({
      ids: servers.map(server => server.id),
      userRef: deps.subjectId,
    });
    for (const token of tokens.values()) {
      values.push(token.accessToken, token.refreshToken);
    }
  }

  return normalizeSecrets(values);
}
