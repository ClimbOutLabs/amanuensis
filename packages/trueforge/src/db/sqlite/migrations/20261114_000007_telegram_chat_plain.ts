import { sql, type Kysely } from 'kysely';

/**
 * A Telegram chat made before this was bound to the hidden agent the host makes for an owner's
 * schedules, so the app listed it under that agent's made-up name and its setup could not be
 * changed. It becomes a plain chat on that agent's setup, as a new Telegram chat now starts.
 * Only Telegram chats bound to a host-made agent of the same owner change. Mirrors
 * db/postgres/migrations/20261114_000007_telegram_chat_plain.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      UPDATE session
      SET agent_spec = (SELECT a.manifest FROM agent AS a WHERE a.id = session.agent_id),
          agent_id = NULL,
          agent_name = NULL
      WHERE external_id LIKE 'telegram:%'
        AND agent_id IS NOT NULL
        AND agent_spec IS NULL
        AND EXISTS (
          SELECT 1 FROM agent AS a
          WHERE a.id = session.agent_id
            AND a.tenant_id = session.tenant_id
            AND a.host_managed = 1
            AND json_extract(a.created_by_subject, '$.subject_id') = json_extract(session.created_by_subject, '$.subject_id')
        )
    `.execute(trx);
  });
}

/** The chat stays plain: rebinding it to a hidden agent would bring the made-up name back. */
export function down(): Promise<void> {
  return Promise.resolve();
}
