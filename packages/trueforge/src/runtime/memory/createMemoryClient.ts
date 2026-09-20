/**
 * Selects and constructs the memory backend from configuration.
 *
 * `markdown` (the default) needs no MCP server: it stores memories as local Markdown
 * files namespaced by tenant, and is the stable, supported path. `hindsight` is
 * EXPERIMENTAL (rollback only): it talks to the Hindsight REST API behind the MCP
 * server flagged as the memory provider; without one, memory is disabled.
 */
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core';
import type { MemoryBackend } from '../../config';
import { HindsightClient } from './hindsightClient';
import { MarkdownMemoryClient } from './markdownMemoryClient';
import type { MemoryClient } from './memoryClient';

export function createMemoryClient(input: {
  backend: MemoryBackend;
  markdownDir: string;
  namespace: string;
  hindsight: { apiBase: string; bank: string; headers: RemoteMcpHeaders } | undefined;
}): MemoryClient | undefined {
  if (input.backend === 'hindsight') {
    if (input.hindsight === undefined) {
      return undefined;
    }
    return new HindsightClient({
      apiBase: input.hindsight.apiBase,
      bank: input.hindsight.bank,
      headers: input.hindsight.headers,
    });
  }
  return new MarkdownMemoryClient({ baseDir: input.markdownDir, namespace: input.namespace });
}
