import { getEmbeddingSubsystem } from './embeddingRetrieval';
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

/** The Markdown memory of one tenant: local files, no server to reach. */
export function createMemoryClient(input: {
  markdownDir: string;
  namespace: string;
  /** The persona vault to write and recall from; omitted means the shared vault. */
  vaultScope?: VaultScope | undefined;
  /** Present → meaning-based recall is on. */
  embeddings?: EmbeddingClientOptions | undefined;
}): MemoryClient {
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
