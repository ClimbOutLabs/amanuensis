import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * A Telegram chat made before this was bound to the hidden agent the host makes for an owner's
 * schedules, so the app listed it under that agent's made-up name and its setup could not be
 * changed. It becomes a plain chat on that agent's setup, as a new Telegram chat now starts.
 * Only Telegram chats bound to a host-made agent of the same owner change. Mirrors
 * db/sqlite/migrations/20261114_000007_telegram_chat_plain.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`
      UPDATE session AS s
      SET agent_spec = a.manifest,
          agent_id = NULL,
          agent_name = NULL
      FROM agent AS a
      WHERE s.external_id LIKE 'telegram:%'
        AND s.agent_id IS NOT NULL
        AND s.agent_spec IS NULL
        AND a.id = s.agent_id
        AND a.tenant_id = s.tenant_id
        AND a.host_managed
        AND a.created_by_subject->>'subject_id' = s.created_by_subject->>'subject_id'
    `.execute(trx);
  });
}

/** The chat stays plain: rebinding it to a hidden agent would bring the made-up name back. */
export function down(): Promise<void> {
  return Promise.resolve();
}
