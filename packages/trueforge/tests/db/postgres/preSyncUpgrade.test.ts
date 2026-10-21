import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { Pool } from 'pg';

import { migrateToLatest } from '../../../src/db/migratePostgres';
import { createDb } from '../../../src/db/postgres/client';
import { TABLES_TO_MOVE, TRUEFORGE_SCHEMA, ensureTrueforgeSchema } from '../../../src/db/postgres/schema';
import { newId } from '../../../src/utils/id';
import { preSyncPostgresMigrations } from '../../fixtures/pre-sync-schema-c764d444/preSyncPostgresMigrations';

/**
 * `createDb` pins `search_path` to the `trueforge` schema, which does not
 * exist yet on a pre-sync database (that schema is only created by
 * `ensureTrueforgeSchema`, itself introduced after c764d444). Building the
 * pre-sync fixture needs a plain connection that resolves to `public` like
 * the pre-sync code's own `createDb` did.
 */
function createPreSyncDb(connectionString: string): Kysely<unknown> {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 5 }),
    }),
  });
}

class StaticMigrationProvider implements MigrationProvider {
  readonly #migrations: Record<string, Migration>;

  constructor(migrations: Record<string, Migration>) {
    this.#migrations = migrations;
  }

  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(this.#migrations);
  }
}

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

const ADMIN_URL_ENV = 'PG_STORE_TESTS_ADMIN_URL';

function assertSafeDatabaseName(name: string): void {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`invalid database name: ${name}`);
  }
}

function withDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString.replace(/^postgres:/, 'http:'));
  parsed.pathname = `/${database}`;
  return parsed.toString().replace(/^http:/, 'postgres:');
}

/**
 * Postgres counterpart of `tests/unit/db/preSyncUpgrade.test.ts`: builds a
 * database on the pre-sync (c764d444) migration chain — before the fork's
 * `trueforge` schema move existed, so this chain runs entirely in `public`
 * with no `migrationTableSchema` — and confirms the current migrator
 * (`ensureTrueforgeSchema` + every migration to latest) still succeeds and
 * relocates every fork table into the `trueforge` schema.
 */
describePg('pre-sync (c764d444) Postgres chain upgrades to latest', () => {
  it('runs every pending migration and moves every table into the trueforge schema', async () => {
    const adminUrl = process.env[ADMIN_URL_ENV];
    if (adminUrl === undefined) {
      throw new Error('admin url missing despite PG_STORE_TESTS_ENABLED=1');
    }

    const databaseName = `pre_sync_upgrade_${newId()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`;
    assertSafeDatabaseName(databaseName);

    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminPool.end();
    }

    const databaseUrl = withDatabase(adminUrl, databaseName);

    try {
      const preSyncDb = createPreSyncDb(databaseUrl);
      try {
        const preSyncMigrator = new Migrator({
          db: preSyncDb,
          allowUnorderedMigrations: true,
          provider: new StaticMigrationProvider(preSyncPostgresMigrations),
        });
        const preSyncResult = await preSyncMigrator.migrateToLatest();
        expect(preSyncResult.error).toBeUndefined();
        expect(preSyncResult.results?.some(r => r.status !== 'Success')).toBe(false);
      } finally {
        await preSyncDb.destroy();
      }

      const db = createDb({
        connectionString: databaseUrl,
        poolMax: 5,
        statementTimeoutMs: 60_000,
        idleInTransactionSessionTimeoutMs: 60_000,
      });
      try {
        await expect(migrateToLatest(db)).resolves.toBeUndefined();

        const sessionColumns = await sql<{ column_name: string }>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = ${TRUEFORGE_SCHEMA} AND table_name = 'session'
        `.execute(db);
        const columnNames = sessionColumns.rows.map(row => row.column_name);
        expect(columnNames).toEqual(
          expect.arrayContaining(['workspace_cwd', 'task_checklist', 'repository_id', 'metadata', 'metrics']),
        );

        // migrateToLatest already calls ensureTrueforgeSchema; rerunning it must
        // stay a no-op and every fork table must have landed in trueforge.
        await ensureTrueforgeSchema(db);
        const located = await sql<{ schemaname: string; tablename: string }>`
          SELECT schemaname, tablename FROM pg_tables
          WHERE tablename = ANY(${TABLES_TO_MOVE}) AND schemaname IN ('public', ${TRUEFORGE_SCHEMA})
        `.execute(db);
        const byTable = new Map(located.rows.map(row => [row.tablename, row.schemaname]));
        // A table a later migration drops is absent from both schemas; one still in public was not moved.
        for (const tableName of TABLES_TO_MOVE) {
          expect(byTable.get(tableName)).not.toBe('public');
        }
      } finally {
        await db.destroy();
      }
    } finally {
      const cleanupPool = new Pool({ connectionString: adminUrl });
      try {
        await cleanupPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [databaseName],
        );
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await cleanupPool.end();
      }
    }
  }, 120_000);
});
