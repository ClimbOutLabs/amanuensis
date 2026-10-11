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
import { getEmbeddingSubsystem } from './embeddingRetrieval';
import { HindsightClient } from './hindsightClient';
import { MarkdownMemoryClient } from './markdownMemoryClient';
import type { VaultScope } from './markdownMemoryFiles';
import type { MemoryClient } from './memoryClient';

export interface EmbeddingClientOptions {
  /** Where the embedding model is downloaded once and cached. */
  modelDir: string;
  /** Memories embedded per background-backfill batch. */
  batchSize: number;
  /** Plain-English lifecycle notes (download started/finished, backfill progress). */
  log?: ((message: string) => void) | undefined;
}

export function createMemoryClient(input: {
  backend: MemoryBackend;
  markdownDir: string;
  namespace: string;
  /** Markdown backend only: the persona vault to write and recall from; omitted means the shared vault. */
  vaultScope?: VaultScope | undefined;
  hindsight: { apiBase: string; bank: string; headers: RemoteMcpHeaders } | undefined;
  /** Present → meaning-based recall is on for the markdown backend. */
  embeddings?: EmbeddingClientOptions | undefined;
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
  const embeddingOptions = input.embeddings;
  return new MarkdownMemoryClient({
    baseDir: input.markdownDir,
    namespace: input.namespace,
    vaultScope: input.vaultScope,
    // One subsystem per vault: each namespace keeps its own embedding store.
    embeddings:
      embeddingOptions === undefined
        ? undefined
        : namespace =>
            getEmbeddingSubsystem({
              baseDir: input.markdownDir,
              namespace,
              modelDir: embeddingOptions.modelDir,
              batchSize: embeddingOptions.batchSize,
              log: embeddingOptions.log,
            }),
  });
}
