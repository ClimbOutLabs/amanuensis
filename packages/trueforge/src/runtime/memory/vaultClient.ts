import type { Logger } from 'winston';

import configuration from '../../config';
import { getEmbeddingSubsystem } from './embeddingRetrieval';
import { MarkdownMemoryClient } from './markdownMemoryClient';

/** The tenant's memory vault. */
export function createVaultClient({ logger, tenantId }: { logger: Logger; tenantId: string }): MarkdownMemoryClient {
  return new MarkdownMemoryClient({
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: tenantId,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? namespace =>
          getEmbeddingSubsystem({
            baseDir: configuration.MEMORY_MARKDOWN_DIR,
            namespace,
            modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
            batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
            log: (message: string) => logger.info(message),
          })
      : undefined,
  });
}
