import type { Kysely } from 'kysely';

/**
 * One paired terminal's key, as stored. Only the hash of the key is kept, never the
 * key itself, so reading this table gives nobody a working key. `revoked_at` is set
 * when the key is revoked; a revoked key stops working on the next request.
 */
export interface TerminalKeyRecord {
  id: string;
  tenant_id: string;
  /** The person who confirmed the pairing, in the shape their sign-in gave. */
  subject_id: string;
  subject_type: string;
  subject_display_name: string;
  device_name: string;
  /** SHA-256 of the key the terminal presents, hex encoded. */
  key_hash: string;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

/** One row of `terminal_key`. Times are text on SQLite and timestamptz on Postgres. */
export interface TerminalKeyTable {
  id: string;
  tenant_id: string;
  subject_id: string;
  subject_type: string;
  subject_display_name: string;
  device_name: string;
  key_hash: string;
  created_at: string | Date;
  last_used_at: string | Date;
  revoked_at: string | Date | null;
}

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface TerminalKeyDatabase {
  terminal_key: TerminalKeyTable;
}

function timeText(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/** Row to record: Postgres hands timestamps back as Date, SQLite as the stored text. */
export function terminalKeyRecordFromRow(row: TerminalKeyTable): TerminalKeyRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_id: row.subject_id,
    subject_type: row.subject_type,
    subject_display_name: row.subject_display_name,
    device_name: row.device_name,
    key_hash: row.key_hash,
    created_at: timeText(row.created_at),
    last_used_at: timeText(row.last_used_at),
    revoked_at: row.revoked_at === null ? null : timeText(row.revoked_at),
  };
}

export interface ITerminalKeyStore {
  /** Stores a freshly paired terminal key. The record carries the key hash, never the key. */
  create(record: TerminalKeyRecord): Promise<void>;
  /** The key with this hash, live or revoked, or undefined when no pairing ever made it. */
  findByKeyHash(key_hash: string): Promise<TerminalKeyRecord | undefined>;
  /** Every key the person paired, newest first, revoked ones included so the list can show them. */
  listForOwner(input: { tenant_id: string; subject_id: string }): Promise<TerminalKeyRecord[]>;
  /** Moves the last-used time of a key to the given moment. */
  markUsed(input: { id: string; used_at: string }): Promise<void>;
  /**
   * Revokes one of the person's keys. Returns true when a live key was revoked, and
   * false when the key is not theirs or was already revoked.
   */
  revoke(input: { tenant_id: string; subject_id: string; id: string; revoked_at: string }): Promise<boolean>;
  /** Revokes every live key the person paired, as a password change does. Returns how many were revoked. */
  revokeAllForOwner(input: { tenant_id: string; subject_id: string; revoked_at: string }): Promise<number>;
}

/**
 * Paired terminal keys, stored in the app database so a key survives restarts and a
 * revoke lands on every replica. One class serves both databases, like the recall
 * exclusion store.
 */
export class TerminalKeyStore implements ITerminalKeyStore {
  readonly #db: Kysely<TerminalKeyDatabase>;

  constructor(db: Kysely<TerminalKeyDatabase>) {
    this.#db = db;
  }

  async create(record: TerminalKeyRecord): Promise<void> {
    await this.#db
      .insertInto('terminal_key')
      .values({
        id: record.id,
        tenant_id: record.tenant_id,
        subject_id: record.subject_id,
        subject_type: record.subject_type,
        subject_display_name: record.subject_display_name,
        device_name: record.device_name,
        key_hash: record.key_hash,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        revoked_at: record.revoked_at,
      })
      .execute();
  }

  async findByKeyHash(key_hash: string): Promise<TerminalKeyRecord | undefined> {
    const row = await this.#db
      .selectFrom('terminal_key')
      .selectAll()
      .where('key_hash', '=', key_hash)
      .executeTakeFirst();
    return row === undefined ? undefined : terminalKeyRecordFromRow(row);
  }

  async listForOwner(input: { tenant_id: string; subject_id: string }): Promise<TerminalKeyRecord[]> {
    const rows = await this.#db
      .selectFrom('terminal_key')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('subject_id', '=', input.subject_id)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(terminalKeyRecordFromRow);
  }

  async markUsed(input: { id: string; used_at: string }): Promise<void> {
    await this.#db
      .updateTable('terminal_key')
      .set({ last_used_at: input.used_at })
      .where('id', '=', input.id)
      .execute();
  }

  async revoke(input: { tenant_id: string; subject_id: string; id: string; revoked_at: string }): Promise<boolean> {
    const result = await this.#db
      .updateTable('terminal_key')
      .set({ revoked_at: input.revoked_at })
      .where('id', '=', input.id)
      .where('tenant_id', '=', input.tenant_id)
      .where('subject_id', '=', input.subject_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async revokeAllForOwner(input: { tenant_id: string; subject_id: string; revoked_at: string }): Promise<number> {
    const result = await this.#db
      .updateTable('terminal_key')
      .set({ revoked_at: input.revoked_at })
      .where('tenant_id', '=', input.tenant_id)
      .where('subject_id', '=', input.subject_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
