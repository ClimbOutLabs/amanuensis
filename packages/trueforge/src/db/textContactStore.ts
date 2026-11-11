import { sql, type Kysely } from 'kysely';

import { TextContactSchema, type TextContact, type TextContactExport, type TextMode } from '../schemas/textMessages';
import type { PersonOwner } from './personOwner';

/** One row of `text_contact`. Times are text on SQLite and timestamptz on Postgres. */
export interface TextContactTable {
  tenant_id: string;
  created_by: string;
  phone: string;
  mode: string;
  confirmed_at: string | Date | null;
  opted_out_at: string | Date | null;
  pending_phone: string | null;
  code_hash: string | null;
  code_salt: string | null;
  code_key_id: string | null;
  code_expires_at: string | Date | null;
  code_attempts: number;
  updated_at: string | Date;
}

/** Texts sent in one window for one key, such as a person, a number or the server. Kept apart from `text_contact`. */
export interface TextSendCountTable {
  scope_key: string;
  window_started_at: string | Date;
  sends: number;
}

/** One word a person lets Aman text besides the common words. */
export interface TextWordTable {
  tenant_id: string;
  created_by: string;
  word: string;
  created_at: string | Date;
}

export interface TextContactDatabase {
  text_contact: TextContactTable;
  text_send_count: TextSendCountTable;
  text_word: TextWordTable;
}

/** A one-time code as stored: its keyed hash, the salt it was hashed with, which key hashed it, and when it runs out. */
interface StoredCode {
  hash: string;
  salt: string;
  key_id: string;
  expires_at: string;
}

/** At most `max` sends for `key` in a window that ends `window_ms` after its first send, at most a day. */
export interface TextSendLimit {
  key: string;
  window_ms: number;
  max: number;
}

/** Refused, it names the limit that refused and when that limit's full window started. */
type TextSendsClaim = { ok: true } | { ok: false; refused: TextSendLimit; window_started_at: string };

/** Thrown inside the claim transaction so a refusal undoes the limits already counted. */
class TextSendRefused extends Error {
  readonly refused: TextSendLimit;

  constructor(refused: TextSendLimit) {
    super('A text send limit refused the send.');
    this.refused = refused;
  }
}

/**
 * A person's number for texts. Owner-scoped: no read or write by owner reaches another person's row. Every change
 * after a read is conditional on what was read, so two requests at once cannot undo each other.
 */
export interface ITextContactStore {
  get(owner: PersonOwner): Promise<TextContact | undefined>;
  /**
   * Starts a code. As `number`, the phone becomes the person's number: the same number keeps its confirmation, another
   * one starts unconfirmed. As `new_number`, it waits beside a confirmed number, which keeps getting texts; this
   * resolves to false when the person has no confirmed number to keep.
   */
  startCode(
    input: PersonOwner & { phone: string; as: 'number' | 'new_number'; code: StoredCode; now: Date },
  ): Promise<boolean>;
  /** Confirms the code with this hash, and swaps in a waiting new number. False when that code is no longer pending. */
  confirmCode(input: PersonOwner & { code_hash: string; now: Date }): Promise<boolean>;
  /** Forgets the code with this hash and any new number waiting for it. False when that code is no longer pending. */
  clearCode(input: PersonOwner & { code_hash: string; now: Date }): Promise<boolean>;
  /**
   * Counts one try at the pending code and resolves to the new count, or undefined when no code is pending. The count
   * moves in the database, so two tries at once cannot both be the last one allowed.
   */
  countCodeAttempt(owner: PersonOwner): Promise<number | undefined>;
  /** False when the person has no number. */
  setMode(input: PersonOwner & { mode: TextMode; now: Date }): Promise<boolean>;
  /**
   * A STOP from this number, across tenants: where someone confirmed it, it is opted out and keeps its confirmation;
   * where it only waits for its code, as someone's number or as a new one, it is dropped.
   */
  optOut(input: { phone: string; now: Date }): Promise<{
    opted_out: PersonOwner[];
    unconfirmed_dropped: PersonOwner[];
    pending_dropped: PersonOwner[];
  }>;
  /** Removes the person's number. Codes already sent stay counted. Resolves to whether there was one. */
  remove(owner: PersonOwner): Promise<boolean>;
  /** Adds an exported number as unconfirmed when the person has none; one already there is kept. Resolves to whether it was added. */
  importContact(
    input: PersonOwner & { contact: TextContactExport; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<boolean>;
  /**
   * Counts one text send against every limit in one transaction, or against none when any limit is full, so a send
   * one limit refuses spends none of the others and sends at the same moment cannot pass `max` together. A window
   * ends `window_ms` after its first send. Refused, it says which limit refused and when its full window started.
   */
  claimTextSends(input: { limits: readonly TextSendLimit[]; now: Date }): Promise<TextSendsClaim>;
  /** Forgets counts whose window started before this time. */
  forgetTextSends(input: { before: Date }): Promise<void>;
  /** The words the person lets Aman text, in order of the letters. */
  listWords(owner: PersonOwner): Promise<string[]>;
  /** Adds a word, or says it is already there or that the person has `max` words already. */
  addWord(input: PersonOwner & { word: string; max: number; now: Date }): Promise<'added' | 'exists' | 'full'>;
  /** Resolves to whether the word was there. */
  removeWord(input: PersonOwner & { word: string }): Promise<boolean>;
  /** Adds exported words the person does not have yet, up to `max` in all. */
  importWords(
    input: PersonOwner & { words: readonly string[]; max: number; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<void>;
}

function isoTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : isoTime(value);
}

function toContact(row: TextContactTable): TextContact {
  return TextContactSchema.parse({
    phone: row.phone,
    mode: row.mode,
    confirmed_at: iso(row.confirmed_at),
    opted_out_at: iso(row.opted_out_at),
    pending_phone: row.pending_phone,
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    code_key_id: row.code_key_id,
    code_expires_at: iso(row.code_expires_at),
    code_attempts: row.code_attempts,
  });
}

/** A number with nothing confirmed and no code, checked before it is written so a row that could not be read back is never stored. */
function freshRow({
  owner,
  phone,
  mode,
  now,
}: {
  owner: PersonOwner;
  phone: string;
  mode: TextMode;
  now: Date;
}): TextContactTable {
  const row = {
    ...owner,
    phone,
    mode,
    confirmed_at: null,
    opted_out_at: null,
    pending_phone: null,
    code_hash: null,
    code_salt: null,
    code_key_id: null,
    code_expires_at: null,
    code_attempts: 0,
    updated_at: now.toISOString(),
  };
  toContact(row);
  return row;
}

const NO_CODE = {
  code_hash: null,
  code_salt: null,
  code_key_id: null,
  code_expires_at: null,
  code_attempts: 0,
} as const;

function ownerOf(row: PersonOwner): PersonOwner {
  return { tenant_id: row.tenant_id, created_by: row.created_by };
}

export class TextContactStore implements ITextContactStore {
  readonly #db: Kysely<TextContactDatabase>;

  constructor(db: Kysely<TextContactDatabase>) {
    this.#db = db;
  }

  async get(owner: PersonOwner): Promise<TextContact | undefined> {
    const row = await this.#db
      .selectFrom('text_contact')
      .selectAll()
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : toContact(row);
  }

  async startCode(
    input: PersonOwner & { phone: string; as: 'number' | 'new_number'; code: StoredCode; now: Date },
  ): Promise<boolean> {
    const owner = ownerOf(input);
    const phone = TextContactSchema.shape.phone.parse(input.phone);
    const codeColumns = {
      code_hash: input.code.hash,
      code_salt: input.code.salt,
      code_key_id: input.code.key_id,
      code_expires_at: input.code.expires_at,
      code_attempts: 0,
      updated_at: input.now.toISOString(),
    };
    if (input.as === 'new_number') {
      const updated = await this.#db
        .updateTable('text_contact')
        .set({ ...codeColumns, pending_phone: phone })
        .where('tenant_id', '=', owner.tenant_id)
        .where('created_by', '=', owner.created_by)
        .where('confirmed_at', 'is not', null)
        .where('opted_out_at', 'is', null)
        .where('phone', '<>', phone)
        .returning('created_by')
        .executeTakeFirst();
      return updated !== undefined;
    }
    const row = { ...freshRow({ owner, phone, mode: 'private', now: input.now }), ...codeColumns };
    await this.#db
      .insertInto('text_contact')
      .values(row)
      .onConflict(conflict =>
        conflict.columns(['tenant_id', 'created_by']).doUpdateSet({
          ...codeColumns,
          phone,
          pending_phone: null,
          // The same number keeps what it earned, so a fresh code never switches it off. Another number starts over.
          confirmed_at: sql`CASE WHEN text_contact.phone = ${phone} THEN text_contact.confirmed_at ELSE NULL END`,
          opted_out_at: sql`CASE WHEN text_contact.phone = ${phone} THEN text_contact.opted_out_at ELSE NULL END`,
        }),
      )
      .execute();
    return true;
  }

  async confirmCode(input: PersonOwner & { code_hash: string; now: Date }): Promise<boolean> {
    const at = input.now.toISOString();
    const updated = await this.#db
      .updateTable('text_contact')
      .set(eb => ({
        ...NO_CODE,
        phone: eb.fn.coalesce('pending_phone', 'phone'),
        pending_phone: null,
        confirmed_at: at,
        opted_out_at: null,
        updated_at: at,
      }))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('code_hash', '=', input.code_hash)
      .returning('created_by')
      .executeTakeFirst();
    return updated !== undefined;
  }

  async clearCode(input: PersonOwner & { code_hash: string; now: Date }): Promise<boolean> {
    const updated = await this.#db
      .updateTable('text_contact')
      .set({ ...NO_CODE, pending_phone: null, updated_at: input.now.toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('code_hash', '=', input.code_hash)
      .returning('created_by')
      .executeTakeFirst();
    return updated !== undefined;
  }

  async countCodeAttempt(owner: PersonOwner): Promise<number | undefined> {
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

  async setMode(input: PersonOwner & { mode: TextMode; now: Date }): Promise<boolean> {
    const updated = await this.#db
      .updateTable('text_contact')
      .set({ mode: input.mode, updated_at: input.now.toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .returning('created_by')
      .executeTakeFirst();
    return updated !== undefined;
  }

  async optOut(input: { phone: string; now: Date }): Promise<{
    opted_out: PersonOwner[];
    unconfirmed_dropped: PersonOwner[];
    pending_dropped: PersonOwner[];
  }> {
    const at = input.now.toISOString();
    // A confirmed number keeps its confirmation, so it stays its owner's for the limits; texts stop on the STOP mark.
    const optedOut = await this.#db
      .updateTable('text_contact')
      .set({ ...NO_CODE, pending_phone: null, opted_out_at: at, updated_at: at })
      .where('phone', '=', input.phone)
      .where('confirmed_at', 'is not', null)
      .returning(['tenant_id', 'created_by'])
      .execute();
    // A number only waiting for its code was never proved, so it is dropped wherever it waits.
    const unconfirmed = await this.#db
      .deleteFrom('text_contact')
      .where('phone', '=', input.phone)
      .where('confirmed_at', 'is', null)
      .returning(['tenant_id', 'created_by'])
      .execute();
    const dropped = await this.#db
      .updateTable('text_contact')
      .set({ ...NO_CODE, pending_phone: null, updated_at: at })
      .where('pending_phone', '=', input.phone)
      .returning(['tenant_id', 'created_by'])
      .execute();
    return {
      opted_out: optedOut.map(ownerOf),
      unconfirmed_dropped: unconfirmed.map(ownerOf),
      pending_dropped: dropped.map(ownerOf),
    };
  }

  async remove(owner: PersonOwner): Promise<boolean> {
    const removed = await this.#db
      .deleteFrom('text_contact')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .returning('created_by')
      .execute();
    return removed.length > 0;
  }

  async importContact(
    input: PersonOwner & { contact: TextContactExport; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = freshRow({
      owner: ownerOf(input),
      phone: input.contact.phone,
      mode: input.contact.mode,
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

  async claimTextSends(input: { limits: readonly TextSendLimit[]; now: Date }): Promise<TextSendsClaim> {
    const at = input.now.toISOString();
    try {
      await this.#db.transaction().execute(async trx => {
        for (const limit of input.limits) {
          const over = new Date(input.now.getTime() - limit.window_ms).toISOString();
          const ended = sql<boolean>`text_send_count.window_started_at <= ${over}`;
          const claimed = await trx
            .insertInto('text_send_count')
            .values({ scope_key: limit.key, window_started_at: at, sends: 1 })
            .onConflict(conflict =>
              conflict
                .column('scope_key')
                .doUpdateSet({
                  window_started_at: sql`CASE WHEN ${ended} THEN ${at} ELSE text_send_count.window_started_at END`,
                  sends: sql`CASE WHEN ${ended} THEN 1 ELSE text_send_count.sends + 1 END`,
                })
                .where(sql<boolean>`${ended} OR text_send_count.sends < ${limit.max}`),
            )
            .returning('sends')
            .executeTakeFirst();
          if (claimed === undefined) {
            throw new TextSendRefused(limit);
          }
        }
      });
      return { ok: true };
    } catch (caught) {
      if (!(caught instanceof TextSendRefused)) {
        throw caught;
      }
      const row = await this.#db
        .selectFrom('text_send_count')
        .select('window_started_at')
        .where('scope_key', '=', caught.refused.key)
        .executeTakeFirst();
      return {
        ok: false,
        refused: caught.refused,
        window_started_at: row === undefined ? at : isoTime(row.window_started_at),
      };
    }
  }

  async forgetTextSends(input: { before: Date }): Promise<void> {
    await this.#db.deleteFrom('text_send_count').where('window_started_at', '<', input.before.toISOString()).execute();
  }

  async listWords(owner: PersonOwner): Promise<string[]> {
    const rows = await this.#db
      .selectFrom('text_word')
      .select('word')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .orderBy('word')
      .execute();
    return rows.map(row => row.word);
  }

  async addWord(input: PersonOwner & { word: string; max: number; now: Date }): Promise<'added' | 'exists' | 'full'> {
    return await this.#db.transaction().execute(async trx => {
      const owner = ownerOf(input);
      const there = await trx
        .selectFrom('text_word')
        .select('word')
        .where('tenant_id', '=', owner.tenant_id)
        .where('created_by', '=', owner.created_by)
        .execute();
      if (there.some(row => row.word === input.word)) {
        return 'exists';
      }
      if (there.length >= input.max) {
        return 'full';
      }
      await trx
        .insertInto('text_word')
        .values({ ...owner, word: input.word, created_at: input.now.toISOString() })
        .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'word']).doNothing())
        .execute();
      return 'added';
    });
  }

  async removeWord(input: PersonOwner & { word: string }): Promise<boolean> {
    const removed = await this.#db
      .deleteFrom('text_word')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('word', '=', input.word)
      .returning('word')
      .execute();
    return removed.length > 0;
  }

  async importWords(
    input: PersonOwner & { words: readonly string[]; max: number; now?: Date },
    transaction?: Kysely<TextContactDatabase>,
  ): Promise<void> {
    const db = transaction ?? this.#db;
    const owner = ownerOf(input);
    const there = await db
      .selectFrom('text_word')
      .select('word')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
    const have = new Set(there.map(row => row.word));
    const fresh = [...new Set(input.words)]
      .filter(word => !have.has(word))
      .slice(0, Math.max(0, input.max - have.size));
    if (fresh.length === 0) {
      return;
    }
    const at = (input.now ?? new Date()).toISOString();
    await db
      .insertInto('text_word')
      .values(fresh.map(word => ({ ...owner, word, created_at: at })))
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by', 'word']).doNothing())
      .execute();
  }
}
