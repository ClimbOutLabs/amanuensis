import type { Transaction } from 'kysely';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeLibrary } from '../../../../src/cli/demoSeed/knowledgeLibrary';
import type { DemoSeedStores } from '../../../../src/cli/demoSeed/seed';
import { createSqliteDemoSeedStores } from '../../../../src/cli/demoSeed/stores';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';
import { personaKnowledgeLocation } from '../../../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../../../src/personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../../../../src/runtime/memory/embeddingModel';

export const TENANT_ID = 'default';
export const USER_ID = 'judge@example.com';
export const MODEL_NAME = 'demo-provider/demo-model';

export type TestStores = DemoSeedStores<Transaction<Database>>;

export interface TestWorld {
  stores: TestStores;
  memoryDir: string;
  knowledgeDir: string;
  /** Documents the indexer was asked to index, in order. */
  queued: { personaId: string; documentId: string }[];
  teardown(): Promise<void>;
}

/**
 * Real SQLite stores on a throwaway migrated database, markdown memory and persona libraries in a temp
 * directory. The indexer is replaced by one that marks each queued document ready, because the real one
 * needs the search model; what is under test is what the seed saves, not the embedding.
 */
export async function createTestWorld(options: { indexes?: boolean } = {}): Promise<TestWorld> {
  const indexes = options.indexes ?? true;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-seed-'));
  const db = createSqliteDb(path.join(dir, 'store.sqlite'));
  await migrateSqliteToLatest(db);
  const memoryDir = path.join(dir, 'memory');
  const knowledgeDir = path.join(dir, 'knowledge');
  const queued: TestWorld['queued'] = [];
  const knowledge = createKnowledgeLibrary({
    knowledgeDir,
    tenantId: TENANT_ID,
    enqueue: ({ personaId, documentId }) => {
      queued.push({ personaId, documentId });
      if (indexes) {
        const repo = openPersonaKnowledgeRepository({
          dbPath: personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT_ID, personaId }).dbPath,
          dimensions: EMBEDDING_DIMENSIONS,
        });
        repo.updateDocumentStatus({ documentId, status: 'ready' });
        repo.close();
      }
    },
  });
  return {
    stores: createSqliteDemoSeedStores({ db, memoryDir, tenantId: TENANT_ID, knowledge }),
    memoryDir,
    knowledgeDir,
    queued,
    async teardown() {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
