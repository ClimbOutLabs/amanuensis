import { sql, type Kysely } from 'kysely';

/**
 * Repair rows corrupted by a session-store write bug: `approval_grants`
 * (and the createTurn merge write) bound a bare JS `string[]` directly
 * instead of going through the `json()` helper. node-pg encodes a bare
 * array as the Postgres ARRAY literal `'{}'`/`'{"a","b"}'`, which then
 * casts to the jsonb column as an empty OBJECT (or fails to parse for
 * non-empty grants) instead of a JSON array. Downstream code spreads this
 * column as `string[]` (`[...locked.approval_grants, ...]`), which threw
 * "approval_grants is not iterable" for every row written before the write
 * sites were fixed to use `json()`.
 *
 * The column's type/constraint (`jsonb NOT NULL DEFAULT '[]'::jsonb`) was
 * already correct — only previously written values are wrong — so this is
 * a data-only repair, not a schema change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE session
    SET approval_grants = '[]'::jsonb
    WHERE jsonb_typeof(approval_grants) <> 'array'
  `.execute(db);
}

/** Irreversible: the pre-repair (corrupted) values are not worth restoring. */
export function down(): Promise<void> {
  return Promise.reject(new Error('20260826_000001_session_approval_grants_repair is not reversible'));
}
