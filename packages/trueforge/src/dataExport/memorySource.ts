import type { Logger } from 'winston';

import configuration from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import { resolveMemoryProvider } from '../runtime/memory/memoryProvider';
import type { MemoryExportSource } from './exportService';

/**
 * The memory the export reads, per the configured backend. A selected backend with no provider
 * set up is not an error: memory is skipped and the manifest says why.
 */
export async function resolveMemoryExportSource<TTransaction>(input: {
  mcpServerStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  tenantId: string;
  subjectId: string;
  logger: Logger;
}): Promise<MemoryExportSource> {
  if (configuration.MEMORY_BACKEND === 'markdown') {
    return { kind: 'markdown', markdownDir: configuration.MEMORY_MARKDOWN_DIR };
  }
  const provider = await resolveMemoryProvider({
    mcpServerStore: input.mcpServerStore,
    tokenStore: input.tokenStore,
    tenantId: input.tenantId,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
    userRef: input.subjectId,
    logger: input.logger,
  });
  const client = createMemoryClient({
    backend: configuration.MEMORY_BACKEND,
    markdownDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: input.tenantId,
    hindsight:
      provider === undefined
        ? undefined
        : { apiBase: provider.apiBase, bank: provider.bank, headers: provider.headers },
  });
  if (client === undefined) {
    return {
      kind: 'unavailable',
      backend: configuration.MEMORY_BACKEND,
      reason: 'No memory provider is set up on this instance, so memory was not exported.',
    };
  }
  return { kind: 'client', backend: configuration.MEMORY_BACKEND, client };
}
