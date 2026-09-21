/**
 * Discovers the configured MCP server designated as the long-term memory provider
 * (`manifest.memory_provider === true`) and resolves it into the pieces a
 * {@link HindsightClient} needs: the REST API base, the bank id, and live request headers.
 *
 * Only consulted when `MEMORY_BACKEND=hindsight` (experimental, rollback only); the
 * default markdown backend skips this lookup entirely.
 */
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { IMcpServerStore } from '../../db/mcpServerStore';
import type { IOAuthTokenStore } from '../../mcp/auth/types';
import type { MemoryProviderSettings } from '../../schemas/mcpServer';
import { getMcpConnection } from '../sessionResources';

const MEMORY_PROVIDER_URL_PATTERN = /^(?<apiBase>https?:\/\/[^/]+)\/mcp\/(?<bank>[^/]+)\/?$/;

export interface MemoryProviderUrl {
  apiBase: string;
  bank: string;
}

/** Parses `{apiBase}/mcp/{bank}/`; returns undefined for anything else. */
export function parseMemoryProviderUrl(url: string): MemoryProviderUrl | undefined {
  const match = MEMORY_PROVIDER_URL_PATTERN.exec(url);
  const apiBase = match?.groups?.['apiBase'];
  const bank = match?.groups?.['bank'];
  if (!apiBase || !bank) {
    return undefined;
  }
  return { apiBase, bank };
}

export interface MemoryProviderConnection {
  serverName: string;
  apiBase: string;
  bank: string;
  headers: RemoteMcpHeaders;
  /** Per-bank tuning from Settings > Memory; undefined when the row carries none. */
  settings: MemoryProviderSettings | undefined;
}

/**
 * Returns the configured memory provider's connection details, or undefined when there is
 * none configured, its URL is not a valid single-bank Hindsight MCP URL (logged once here),
 * or the server row was removed between listing and header resolution. Header resolution
 * (including DCR-auth-required) is left to the caller's actual request: HindsightClient
 * treats it as a per-call failure, so a turn is never delayed here waiting on an OAuth
 * round trip just to decide whether memory is configured.
 */
export async function resolveMemoryProvider(deps: {
  mcpServerStore: IMcpServerStore;
  tokenStore: IOAuthTokenStore;
  tenantId: string;
  clientName: string;
  userRef: string;
  logger: Logger;
}): Promise<MemoryProviderConnection | undefined> {
  const { mcpServerStore, tokenStore, tenantId, clientName, userRef, logger } = deps;
  const servers = await mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
  const flagged = servers
    .filter(server => server.manifest.type === 'remote' && server.manifest.memory_provider === true)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (flagged.length > 1) {
    logger.warn(
      'Multiple MCP servers are flagged as the memory provider; picking the first alphabetically. Disable the flag on the others.',
      { serverNames: flagged.map(server => server.name) },
    );
  }
  const provider = flagged[0];
  if (provider === undefined) {
    return undefined;
  }
  const parsed = parseMemoryProviderUrl(provider.manifest.url);
  if (parsed === undefined) {
    logger.warn('Memory provider MCP server has an invalid URL; memory is disabled for this turn', {
      serverName: provider.name,
      url: provider.manifest.url,
    });
    return undefined;
  }
  const connection = await getMcpConnection({
    tenant_id: tenantId,
    name: provider.name,
    store: mcpServerStore,
    tokenStore,
    clientName,
    userRef,
  });
  if (connection === undefined) {
    return undefined;
  }
  return {
    serverName: provider.name,
    apiBase: parsed.apiBase,
    bank: parsed.bank,
    headers: connection.headers,
    settings: provider.manifest.type === 'remote' ? provider.manifest.memory_settings : undefined,
  };
}

/**
 * The configured memory provider's per-bank settings, straight off the stored manifest, without
 * resolving a live connection or an MCP URL. A local DB read only, so callers that need to know a
 * stored setting (for example, whether the recall screen switch is on) can use it without dialing
 * the bank itself or requiring a token store. Returns undefined when no server is flagged as the
 * memory provider or the flagged row carries no settings.
 */
export async function findMemoryProviderSettings(deps: {
  mcpServerStore: IMcpServerStore;
  tenantId: string;
}): Promise<MemoryProviderSettings | undefined> {
  const { mcpServerStore, tenantId } = deps;
  const servers = await mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
  const flagged = servers
    .filter(server => server.manifest.type === 'remote' && server.manifest.memory_provider === true)
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifest = flagged[0]?.manifest;
  return manifest?.type === 'remote' ? manifest.memory_settings : undefined;
}
