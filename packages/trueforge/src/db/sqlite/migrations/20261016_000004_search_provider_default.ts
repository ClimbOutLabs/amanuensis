import { sql, type Kysely } from 'kysely';

import { McpCatalog } from '../../../catalog/McpCatalog';
import { applySearchProviderDefaultMigration } from '../../applySearchProviderDefaultMigration';

/**
 * SQLite migration: same as Postgres (applySearchProviderDefaultMigration.ts).
 * Reads with json(column) and merges with jsonb_patch so the JSONB blob is never corrupted. Cannot undo.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = new Date().toISOString();
  // Kysely's SqliteAdapter does not wrap migrations; this one opens its own transaction (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await applySearchProviderDefaultMigration({
      db: trx,
      catalog: McpCatalog.load(),
      dialect: {
        readManifest: () => sql`json(manifest)`,
        mergeIntoManifest: patch => sql`jsonb_patch(manifest, jsonb(${JSON.stringify(patch)}))`,
        touchUpdatedAt: () => sql`${now}`,
      },
    });
  });
}

/** The designation is ordinary connector data the user can change, so rolling back keeps it. */
export function down(): Promise<void> {
  return Promise.resolve();
}
