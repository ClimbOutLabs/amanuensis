import type { Kysely } from 'kysely';

import { PhoneCallSchema, type PhoneCall, type PhoneCallMode, type PhoneCallOutcome } from '../schemas/phoneCalls';

/** One row of `phone_call`. Times are text on SQLite and timestamptz on Postgres. */
export interface PhoneCallTable {
  id: string;
  tenant_id: string;
  created_by: string;
  delivery_id: string;
  call_sid: string | null;
  status: string;
  outcome: string | null;
  mode: string | null;
  session_id: string | null;
  fallback: string;
  follow_ups: number;
  /** SHA-256 of the one-time media token, while one is waiting to be used. The token itself is never stored. */
  token_hash: string | null;
  token_expires_at: string | Date | null;
  created_at: string | Date;
  expires_at: string | Date;
  ended_at: string | Date | null;
}

export interface PhoneCallDatabase {
  phone_call: PhoneCallTable;
}

export interface NewPhoneCall {
  id: string;
  tenant_id: string;
  created_by: string;
  delivery_id: string;
  /** False for a test call, which never falls back to a text and a push. */
  fallback: boolean;
  now: Date;
  expires_at: Date;
}

/**
 * The calls Aman placed. Twilio's requests name a call only by its call id, so lookups are by that id; every write is
 * a conditional update, so two requests about the same call cannot both move it on.
 */
export interface IPhoneCallStore {
  create(input: NewPhoneCall): Promise<PhoneCall>;
  get(id: string): Promise<PhoneCall | undefined>;
  getBySid(call_sid: string): Promise<PhoneCall | undefined>;
  /** Records Twilio's id for a call still dialing. Resolves to false when the call already has one or moved on. */
  attachSid(input: { id: string; call_sid: string }): Promise<boolean>;
  /**
   * Stores a one-time media token for a ringing call that has not expired, and moves it to `connecting`. Only the
   * first request wins: a call is connected once.
   */
  issueToken(input: {
    call_sid: string;
    token_hash: string;
    token_expires_at: Date;
    mode: PhoneCallMode;
    now: Date;
  }): Promise<boolean>;
  /**
   * Uses up a media token: it must match this call, be unused and unexpired. Resolves to the call, now `connected`,
   * or undefined. A token works once.
   */
  redeemToken(input: { call_sid: string; token_hash: string; now: Date }): Promise<PhoneCall | undefined>;
  setSession(input: { id: string; session_id: string }): Promise<void>;
  /** Ends a call once. Resolves to false when it had already ended. */
  finish(input: { id: string; outcome: PhoneCallOutcome; follow_ups: number; now: Date }): Promise<boolean>;
  /** Claims the one fallback a missed call may send. Resolves to false when it was sent already or is off. */
  claimFallback(id: string): Promise<boolean>;
}

function iso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toCall(row: PhoneCallTable): PhoneCall {
  return PhoneCallSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    delivery_id: row.delivery_id,
    call_sid: row.call_sid,
    status: row.status,
    outcome: row.outcome,
    mode: row.mode,
    session_id: row.session_id,
    fallback: row.fallback,
    follow_ups: row.follow_ups,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    ended_at: iso(row.ended_at),
  });
}

export class PhoneCallStore implements IPhoneCallStore {
  readonly #db: Kysely<PhoneCallDatabase>;

  constructor(db: Kysely<PhoneCallDatabase>) {
    this.#db = db;
  }

  async create(input: NewPhoneCall): Promise<PhoneCall> {
    const row: PhoneCallTable = {
      id: input.id,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      delivery_id: input.delivery_id,
      call_sid: null,
      status: 'dialing',
      outcome: null,
      mode: null,
      session_id: null,
      fallback: input.fallback ? 'pending' : 'off',
      follow_ups: 0,
      token_hash: null,
      token_expires_at: null,
      created_at: input.now.toISOString(),
      expires_at: input.expires_at.toISOString(),
      ended_at: null,
    };
    await this.#db.insertInto('phone_call').values(row).execute();
    return toCall(row);
  }

  async get(id: string): Promise<PhoneCall | undefined> {
    const row = await this.#db.selectFrom('phone_call').selectAll().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toCall(row);
  }

  async getBySid(call_sid: string): Promise<PhoneCall | undefined> {
    const row = await this.#db.selectFrom('phone_call').selectAll().where('call_sid', '=', call_sid).executeTakeFirst();
    return row === undefined ? undefined : toCall(row);
  }

  async attachSid({ id, call_sid }: { id: string; call_sid: string }): Promise<boolean> {
    const rows = await this.#db
      .updateTable('phone_call')
      .set({ call_sid, status: 'ringing' })
      .where('id', '=', id)
      .where('status', '=', 'dialing')
      .where('call_sid', 'is', null)
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async issueToken(input: {
    call_sid: string;
    token_hash: string;
    token_expires_at: Date;
    mode: PhoneCallMode;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.#db
      .updateTable('phone_call')
      .set({
        status: 'connecting',
        mode: input.mode,
        token_hash: input.token_hash,
        token_expires_at: input.token_expires_at.toISOString(),
      })
      .where('call_sid', '=', input.call_sid)
      .where('status', '=', 'ringing')
      .where('expires_at', '>', input.now.toISOString())
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async redeemToken(input: { call_sid: string; token_hash: string; now: Date }): Promise<PhoneCall | undefined> {
    const row = await this.#db
      .updateTable('phone_call')
      .set({ status: 'connected', token_hash: null, token_expires_at: null })
      .where('call_sid', '=', input.call_sid)
      .where('token_hash', '=', input.token_hash)
      .where('status', '=', 'connecting')
      .where('token_expires_at', '>', input.now.toISOString())
      .where('expires_at', '>', input.now.toISOString())
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toCall(row);
  }

  async setSession({ id, session_id }: { id: string; session_id: string }): Promise<void> {
    await this.#db.updateTable('phone_call').set({ session_id }).where('id', '=', id).execute();
  }

  async finish(input: { id: string; outcome: PhoneCallOutcome; follow_ups: number; now: Date }): Promise<boolean> {
    const rows = await this.#db
      .updateTable('phone_call')
      .set({
        status: 'ended',
        outcome: input.outcome,
        follow_ups: input.follow_ups,
        token_hash: null,
        token_expires_at: null,
        ended_at: input.now.toISOString(),
      })
      .where('id', '=', input.id)
      .where('status', '!=', 'ended')
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async claimFallback(id: string): Promise<boolean> {
    const rows = await this.#db
      .updateTable('phone_call')
      .set({ fallback: 'done' })
      .where('id', '=', id)
      .where('fallback', '=', 'pending')
      .returning('id')
      .execute();
    return rows.length > 0;
  }
}
