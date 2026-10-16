import type { Transaction } from 'kysely';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DemoSeedStores } from '../../../../src/cli/demoSeed/seed';
import { createSqliteDemoSeedStores } from '../../../../src/cli/demoSeed/stores';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

export const TENANT_ID = 'default';
export const USER_ID = 'judge@example.com';
export const MODEL_NAME = 'demo-provider/demo-model';

export type TestStores = DemoSeedStores<Transaction<Database>>;

export interface TestWorld {
  stores: TestStores;
  memoryDir: string;
  teardown(): Promise<void>;
}

/** Real SQLite stores on a throwaway migrated database, with markdown memory in a temp directory. */
export async function createTestWorld(): Promise<TestWorld> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-seed-'));
  const db = createSqliteDb(path.join(dir, 'store.sqlite'));
  await migrateSqliteToLatest(db);
  const memoryDir = path.join(dir, 'memory');
  return {
    stores: createSqliteDemoSeedStores({ db, memoryDir, tenantId: TENANT_ID }),
    memoryDir,
    async teardown() {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
