import { sql } from 'kysely';

import { migrateToLatest } from '../../../../src/db/migratePostgres';
import { PREVIOUS_MIGRATION, runSearchProviderDefaultMigrationSuite } from '../../searchProviderDefaultMigrationSuite';
import { createPostgresTestDatabase } from '../testDatabase';

runSearchProviderDefaultMigrationSuite({
  describeFn: process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip,
  setup: async () => {
    const env = await createPostgresTestDatabase(PREVIOUS_MIGRATION);
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
    return {
      async insert(row) {
        await sql`
          INSERT INTO mcp_server (id, tenant_id, name, manifest, created_at, updated_at)
          VALUES (${row.id}, ${row.tenant_id}, ${row.name}, ${JSON.stringify(row.manifest)}::jsonb, now(), now())
        `.execute(env.db);
      },
      async migrate() {
        await migrateToLatest(env.db);
      },
      async manifestOf(id) {
        const { rows } = await sql<{
          manifest: Record<string, unknown>;
        }>`SELECT manifest FROM mcp_server WHERE id = ${id}`.execute(env.db);
        return rows[0]?.manifest ?? {};
      },
      teardown: () => env.teardown(),
    };
  },
});
