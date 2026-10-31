import {
  ToolSet,
  createSentinelHostContext,
  type IToolSet,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core/mcp/RemoteMCP';
import type { SearchProviderGrant } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import {
  AMAN_SOURCES_SERVER_ID,
  AMAN_SOURCES_TOOL_NAME,
  AmanSourcesSource,
  amanSourcePrefixes,
} from '@truefoundry/trueforge-core/core/search/AmanSourcesSource';
import {
  TavilyClient,
  isTavilyConnectorUrl,
  tavilyAuthFromHeader,
} from '@truefoundry/trueforge-core/core/search/TavilyClient';
import type { Logger } from 'winston';

/**
 * What the guide's live search needs from the host, resolved once where a turn is set
 * up. Both fields are optional: without a designated search provider the guide has
 * no live search at all, and without a docs site the search covers the repository.
 */
export interface GuideSearchTurnContext {
  /** Name of the connector designated as the web search provider, looked up per turn. Undefined when none is designated. */
  searchProviderServerName?: (() => Promise<string | undefined>) | undefined;
  /** The docs site to search alongside the repository, when this install has one configured. */
  docsSiteUrl?: string | undefined;
}

/** What the turn's resolver hands the host when it asks for the designated provider's connection. */
export interface GuideSearchConnection {
  url: string;
  headers: RemoteMcpHeaders | undefined;
  search_provider: SearchProviderGrant | undefined;
}

/** The saved Authorization header of a connector, whether its headers are static or resolved at connect. */
async function authorizationHeaderOf(headers: RemoteMcpHeaders | undefined): Promise<string | undefined> {
  if (headers === undefined) {
    return undefined;
  }
  const resolved = typeof headers === 'function' ? await headers() : { headers };
  if (!('headers' in resolved)) {
    return undefined;
  }
  const found = Object.entries(resolved.headers).find(([name]) => name.toLowerCase() === 'authorization');
  return found?.[1];
}

/**
 * Builds the guide's one live tool, the search over Aman's public sources, or
 * undefined when this turn may not have it. The tool exists only when Tavily is
 * the configured provider and offline mode is off; every other case returns
 * undefined and the guide answers from its built-in help alone. The check fails
 * closed: any surprise while setting the tool up leaves the guide without it.
 * Approval follows the same rule as web search: the tool set carries the search
 * provider grant for the tool, so the person's search setting decides whether a
 * card shows before a search runs.
 */
export async function buildGuideSearchToolSet(input: {
  context: GuideSearchTurnContext;
  tenantId: string;
  createdBy: string;
  sessionId: string;
  connectionFor: (serverName: string) => Promise<GuideSearchConnection>;
  sentinelServices: SentinelServices | undefined;
  logger: Logger;
}): Promise<IToolSet | undefined> {
  try {
    const providerName = await input.context.searchProviderServerName?.();
    if (providerName === undefined) {
      return undefined;
    }
    const connection = await input.connectionFor(providerName);
    if (connection.search_provider === undefined || !isTavilyConnectorUrl(connection.url)) {
      return undefined;
    }
    const offline =
      input.sentinelServices === undefined
        ? false
        : await input.sentinelServices.isOffline({ tenant_id: input.tenantId, created_by: input.createdBy });
    if (offline) {
      return undefined;
    }
    const source = new AmanSourcesSource({
      id: AMAN_SOURCES_SERVER_ID,
      name: 'Aman sources',
      client: new TavilyClient({
        auth: tavilyAuthFromHeader(await authorizationHeaderOf(connection.headers)),
        fetchImpl: (target, init) => fetch(target, init),
      }),
      prefixes: amanSourcePrefixes({ docsSiteUrl: input.context.docsSiteUrl }),
    });
    return new ToolSet({
      source,
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
      preload: true,
      sentinel: createSentinelHostContext({
        tenant_id: input.tenantId,
        created_by: input.createdBy,
        conversation_id: input.sessionId,
        services: input.sentinelServices,
      }),
      searchProvider: { tools: [AMAN_SOURCES_TOOL_NAME], plumbing_fields: [] },
      logger: input.logger,
    });
  } catch (error) {
    input.logger.warn('the guide search tool could not be set up; the guide answers from its built-in help', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
