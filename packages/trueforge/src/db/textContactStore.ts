import type { Kysely } from 'kysely';

import { TextContactSchema, type TextContact, type TextContactExport } from '../schemas/textMessages';

/** One row of `text_contact`. Times are text on SQLite and timestamptz on Postgres. */
export interface TextContactTable {
  tenant_id: string;
  created_by: string;
  phone: string;
  mode: string;
  confirmed_at: string | Date | null;
  opted_out_at: string | Date | null;
  code_hash: string | null;
  code_salt: string | null;
  code_expires_at: string | Date | null;
  code_attempts: number;
  send_window_started_at: string | Date | null;
  sends_in_window: number;
  updated_at: string | Date;
}

export interface TextContactDatabase {
  text_contact: TextContactTable;
}

export interface TextContactOwner {
  tenant_id: string;
  created_by: string;
}

/** A contact together with the person it belongs to. */
export interface OwnedTextContact extends TextContactOwner {
  contact: TextContact;
}

/** A person's number for texts. Owner-scoped: no read or write by owner reaches another person's row. */
export interface ITextContactStore {
  get(owner: TextContactOwner): Promise<TextContact | undefined>;
  /** Replaces the person's contact whole. */
  put(input: TextContactOwner & { contact: TextContact; now?: Date }): Promise<TextContact>;
  /**
   * Counts one try at the pending code and resolves to the new count, or undefined when no code is pending. The count
   * moves in the database, so two tries at once cannot both be the last one allowed.
   */
  countCodeAttempt(owner: TextContactOwner): Promise<number | undefined>;
  /** Every person who has this number, across tenants, so a STOP reaches them all. */
  listByPhone(phone: string): Promise<OwnedTextContact[]>;
  /** Removes the person's number. Resolves to whether there was one. */
  remove(owner: TextContactOwner): Promise<boolean>;
  /** Adds an exported number as unconfirmed when the person has none; one already there is kept. Resolves to whether it was added. */
  importContact(
    input: TextContactOwner & { contact: TextContactExport; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<boolean>;
}

function iso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toContact(row: TextContactTable): TextContact {
  return TextContactSchema.parse({
    phone: row.phone,
    mode: row.mode,
    confirmed_at: iso(row.confirmed_at),
    opted_out_at: iso(row.opted_out_at),
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    code_expires_at: iso(row.code_expires_at),
    code_attempts: row.code_attempts,
    send_window_started_at: iso(row.send_window_started_at),
    sends_in_window: row.sends_in_window,
  });
}

function toRow({
  owner,
  contact,
  now,
}: {
  owner: TextContactOwner;
  contact: TextContact;
  now: Date;
}): TextContactTable {
  return { ...owner, ...contact, updated_at: now.toISOString() };
}

export class TextContactStore implements ITextContactStore {
  readonly #db: Kysely<TextContactDatabase>;

  constructor(db: Kysely<TextContactDatabase>) {
    this.#db = db;
  }

  async get(owner: TextContactOwner): Promise<TextContact | undefined> {
    const row = await this.#db
      .selectFrom('text_contact')
      .selectAll()
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : toContact(row);
  }

  async put(input: TextContactOwner & { contact: TextContact; now?: Date }): Promise<TextContact> {
    // Parsed before the write, so a row that could not be read back is never stored.
    const contact = TextContactSchema.parse(input.contact);
    const row = toRow({
      owner: { tenant_id: input.tenant_id, created_by: input.created_by },
      contact,
      now: input.now ?? new Date(),
    });
    await this.#db
      .insertInto('text_contact')
      .values(row)
      .onConflict(conflict =>
        conflict.columns(['tenant_id', 'created_by']).doUpdateSet({
          phone: row.phone,
          mode: row.mode,
          confirmed_at: row.confirmed_at,
          opted_out_at: row.opted_out_at,
          code_hash: row.code_hash,
          code_salt: row.code_salt,
          code_expires_at: row.code_expires_at,
          code_attempts: row.code_attempts,
          send_window_started_at: row.send_window_started_at,
          sends_in_window: row.sends_in_window,
          updated_at: row.updated_at,
        }),
      )
      .execute();
    return contact;
  }

  async countCodeAttempt(owner: TextContactOwner): Promise<number | undefined> {
    const row = await this.#db
      .updateTable('text_contact')
      .set(eb => ({ code_attempts: eb('code_attempts', '+', 1) }))
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .where('code_hash', 'is not', null)
      .returning('code_attempts')
      .executeTakeFirst();
    return row?.code_attempts;
  }

  async listByPhone(phone: string): Promise<OwnedTextContact[]> {
    const rows = await this.#db
      .selectFrom('text_contact')
      .selectAll()
      .where('phone', '=', phone)
      .orderBy('tenant_id')
      .orderBy('created_by')
      .execute();
    return rows.map(row => ({ tenant_id: row.tenant_id, created_by: row.created_by, contact: toContact(row) }));
  }

  async remove(owner: TextContactOwner): Promise<boolean> {
    const removed = await this.#db
      .deleteFrom('text_contact')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .returning('created_by')
      .execute();
    return removed.length > 0;
  }

  async importContact(
    input: TextContactOwner & { contact: TextContactExport; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = toRow({
      owner: { tenant_id: input.tenant_id, created_by: input.created_by },
      contact: {
        phone: input.contact.phone,
        mode: input.contact.mode,
        confirmed_at: null,
        opted_out_at: null,
        code_hash: null,
        code_salt: null,
        code_expires_at: null,
        code_attempts: 0,
        send_window_started_at: null,
        sends_in_window: 0,
      },
      now: input.now ?? new Date(),
    });
    const inserted = await db
      .insertInto('text_contact')
      .values(row)
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by']).doNothing())
      .returning('created_by')
      .execute();
    return inserted.length > 0;
  }
}
