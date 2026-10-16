import type { Kysely } from 'kysely';
import type { Database } from '../../db/sqlite/types';
import { dayInZone, type CalendarDay } from './calendar';
import type { DemoKnowledgeLibrary } from './knowledgeLibrary';
import { resetDemoWorld, seedDemoWorld, type ResetReport, type SeedReport } from './seed';
import { createSqliteDemoSeedStores } from './stores';
import { buildDemoWorld } from './world';

/** What the command needs from an open instance; the command itself never touches a store. */
export interface DemoSeedSession {
  /** Fully qualified `provider/model` names configured on the instance. */
  models: readonly string[];
  seed(input: {
    userId: string;
    now: Date;
    timeZone: string;
    modelName: string;
    /** The day to treat as "today"; absent means today in `timeZone`. */
    today: CalendarDay | undefined;
  }): Promise<SeedReport>;
  reset(input: { userId: string }): Promise<ResetReport>;
  close(): Promise<void>;
}

export function buildDemoSession({
  db,
  tenantId,
  memoryDir,
  models,
  knowledge,
}: {
  db: Kysely<Database>;
  tenantId: string;
  memoryDir: string;
  models: readonly string[];
  knowledge: DemoKnowledgeLibrary;
}): DemoSeedSession {
  const stores = createSqliteDemoSeedStores({ db, memoryDir, tenantId, knowledge });
  return {
    models,
    seed: ({ userId, now, timeZone, modelName, today }) =>
      seedDemoWorld({
        stores,
        scope: { tenantId, userId },
        world: buildDemoWorld({ today: today ?? dayInZone({ now, timeZone }), timeZone, modelName }),
        now,
      }),
    reset: ({ userId }) => resetDemoWorld({ stores, scope: { tenantId, userId } }),
    close: () => db.destroy(),
  };
}
