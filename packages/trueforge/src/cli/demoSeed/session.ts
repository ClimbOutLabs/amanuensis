import type { Kysely } from 'kysely';
import type { Database } from '../../db/sqlite/types';
import { resetDemoWorld, seedDemoWorld, type ResetReport, type SeedReport } from './seed';
import { createSqliteDemoSeedStores } from './stores';
import { buildDemoWorld } from './world';

/** What the command needs from an open instance; the command itself never touches a store. */
export interface DemoSeedSession {
  /** Fully qualified `provider/model` names configured on the instance. */
  models: readonly string[];
  runCodeAvailable: boolean;
  seed(input: { userId: string; now: Date; timeZone: string; modelName: string }): Promise<SeedReport>;
  reset(input: { userId: string }): Promise<ResetReport>;
  close(): Promise<void>;
}

export function buildDemoSession({
  db,
  tenantId,
  memoryDir,
  runCodeAvailable,
  models,
}: {
  db: Kysely<Database>;
  tenantId: string;
  memoryDir: string;
  runCodeAvailable: boolean;
  models: readonly string[];
}): DemoSeedSession {
  const stores = createSqliteDemoSeedStores({ db, memoryDir, tenantId });
  return {
    models,
    runCodeAvailable,
    seed: ({ userId, now, timeZone, modelName }) =>
      seedDemoWorld({
        stores,
        scope: { tenantId, userId },
        world: buildDemoWorld({ now, timeZone, modelName, runCodeAvailable }),
        now,
      }),
    reset: ({ userId }) => resetDemoWorld({ stores, scope: { tenantId, userId } }),
    close: () => db.destroy(),
  };
}
