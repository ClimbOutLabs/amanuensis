import type { Kysely } from 'kysely';

import { newId } from '../utils/id';

/** One row of `recall_exclusion`. `created_at` is text on SQLite and timestamptz on Postgres. */
export interface RecallExclusionTable {
  id: string;
  tenant_id: string;
  session_id: string;
  fact_text: string;
  created_at: string | Date;
}

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface RecallExclusionDatabase {
  recall_exclusion: RecallExclusionTable;
}

export interface AddRecallExclusionInput {
  tenant_id: string;
  session_id: string;
  fact_text: string;
}

export interface ListRecallExclusionsInput {
  tenant_id: string;
  session_id: string;
}

export interface DeleteRecallExclusionsInput {
  tenant_id: string;
  session_id: string;
}

export interface IRecallExclusionStore {
  /** Records that a fact is out of one chat's recall. Recording the same fact again changes nothing. */
  add(input: AddRecallExclusionInput): Promise<void>;
  /** The facts pulled out of this chat's recall, in the order they were pulled out. */
  listForSession(input: ListRecallExclusionsInput): Promise<string[]>;
  /** Removes a chat's exclusions with the chat, so nothing of the chat outlives it. */
  deleteForSession(input: DeleteRecallExclusionsInput): Promise<void>;
}

/**
 * Facts a person pulled out of a chat's recall, stored with the chat in the app database:
 * the list survives a restart and holds on every replica, and it is deleted with the chat.
 * The memory itself is never touched; other chats still recall the fact.
 */
export class RecallExclusionStore implements IRecallExclusionStore {
  readonly #db: Kysely<RecallExclusionDatabase>;

  constructor(db: Kysely<RecallExclusionDatabase>) {
    this.#db = db;
  }

  async add(input: AddRecallExclusionInput): Promise<void> {
    const existing = await this.#db
      .selectFrom('recall_exclusion')
      .select('id')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('fact_text', '=', input.fact_text)
      .executeTakeFirst();
    if (existing !== undefined) {
      return;
    }
    await this.#db
      .insertInto('recall_exclusion')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        fact_text: input.fact_text,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  async listForSession(input: ListRecallExclusionsInput): Promise<string[]> {
    const rows = await this.#db
      .selectFrom('recall_exclusion')
      .select('fact_text')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(row => row.fact_text);
  }

  async deleteForSession(input: DeleteRecallExclusionsInput): Promise<void> {
    await this.#db
      .deleteFrom('recall_exclusion')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .execute();
  }
}
