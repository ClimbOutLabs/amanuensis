import { sql, type Kysely } from 'kysely';

import { McpCatalog } from '../../../catalog/McpCatalog';
import { applySearchProviderDefaultMigration } from '../../applySearchProviderDefaultMigration';
import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Designates the search provider for a connector saved before the setting existed.
 * Shared logic lives in applySearchProviderDefaultMigration.ts. Cannot undo.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await applySearchProviderDefaultMigration({
      db: trx,
      catalog: McpCatalog.loadShipped(),
      dialect: {
        readManifest: () => sql`manifest`,
        mergeIntoManifest: patch => sql`manifest || ${JSON.stringify(patch)}::jsonb`,
        touchUpdatedAt: () => sql`now()`,
      },
    });
  });
}

/** The designation is ordinary connector data the user can change, so rolling back keeps it. */
export function down(): Promise<void> {
  return Promise.resolve();
}
