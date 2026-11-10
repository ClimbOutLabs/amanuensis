import { CreatedBySubjectSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Kysely } from 'kysely';

import { newId } from '../utils/id';

/**
 * The Telegram channel's own rows: one connection per owner (the bot, who is paired to it, and where
 * polling left off), the replies a finished turn still owes Telegram, and the approvals waiting on a
 * button tap. Owner-scoped like every other store: no read or write reaches another owner's rows.
 * The bot token sits in the connection row, as other connector secrets sit in theirs; it is never
 * selected into a wire shape, never logged and never returned by a settings read.
 * Times are text on SQLite and timestamptz on Postgres; Telegram's numeric ids are text, so a
 * 64-bit chat or user id never loses precision.
 */

/** One row of `telegram_connection`: the owner's bot and its pairing. */
export interface TelegramConnectionTable {
  id: string;
  tenant_id: string;
  created_by: string;
  /** JSON of the owner's CreatedBySubject, so work the channel starts is owned exactly as in the app. */
  created_by_subject: string;
  bot_token: string;
  /** Telegram's id for the bot itself, as text. */
  bot_id: string;
  bot_name: string;
  bot_username: string | null;
  /** The paired person's Telegram user id, as text; null while nobody is paired. */
  paired_telegram_user_id: string | null;
  /** The private chat with the paired person; null while nobody is paired. */
  paired_chat_id: string | null;
  /** The six-digit code a /start produced, waiting to be confirmed in Settings; null when none waits. */
  pairing_code: string | null;
  pairing_expires_at: string | Date | null;
  /** Who sent the /start the code belongs to; becomes the pairing only on confirm. */
  pairing_telegram_user_id: string | null;
  pairing_chat_id: string | null;
  /** The waiting person's name as Telegram shows it, so Settings can name who would be paired. */
  pairing_display_name: string | null;
  /** The last update id the channel claimed, as text; null before the first update. */
  last_update_id: string | null;
  /** Next update id to ask Telegram for, as text; null before the first poll. */
  poll_offset: string | null;
  /** polling, or webhook when a public https address is configured. */
  transport: string;
  /** Secret the webhook checks on each post; null while polling. */
  webhook_secret: string | null;
  /** The dedicated Telegram chat's session id; null until the first message makes it. */
  session_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** One row of `telegram_pending_reply`: a turn whose answer Telegram has not been sent yet. */
export interface TelegramPendingReplyTable {
  id: string;
  tenant_id: string;
  created_by: string;
  connection_id: string;
  session_id: string;
  turn_id: string;
  /** The Telegram chat the answer goes to, as text. */
  chat_id: string;
  created_at: string | Date;
}

/** One row of `telegram_pending_approval`: one held action offered as Approve and Deny buttons. */
export interface TelegramPendingApprovalTable {
  id: string;
  tenant_id: string;
  created_by: string;
  connection_id: string;
  session_id: string;
  /** The turn that asked; the approval answer is a new turn after it. */
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  /** The Telegram chat the buttons were sent to, as text. */
  chat_id: string;
  /** The plain-words text of the message the buttons sit under. */
  prompt: string;
  /** When the action stops being answerable, when the turn said so. */
  expires_at: string | Date | null;
  created_at: string | Date;
}

export interface TelegramDatabase {
  telegram_connection: TelegramConnectionTable;
  telegram_pending_reply: TelegramPendingReplyTable;
  telegram_pending_approval: TelegramPendingApprovalTable;
}

export interface TelegramOwner {
  tenant_id: string;
  created_by: string;
}

/** A connection as the rest of the server uses it: the row, with times as ISO strings. */
export interface TelegramConnection {
  id: string;
  tenant_id: string;
  created_by: string;
  created_by_subject: CreatedBySubject;
  bot_token: string;
  bot_id: string;
  bot_name: string;
  bot_username: string | null;
  paired_telegram_user_id: string | null;
  paired_chat_id: string | null;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  pairing_telegram_user_id: string | null;
  pairing_chat_id: string | null;
  pairing_display_name: string | null;
  last_update_id: string | null;
  poll_offset: string | null;
  transport: 'polling' | 'webhook';
  webhook_secret: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramPendingReply {
  id: string;
  tenant_id: string;
  created_by: string;
  connection_id: string;
  session_id: string;
  turn_id: string;
  chat_id: string;
  created_at: string;
}

export interface TelegramPendingApproval {
  id: string;
  tenant_id: string;
  created_by: string;
  connection_id: string;
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  chat_id: string;
  prompt: string;
  expires_at: string | null;
  created_at: string;
}

export interface SaveTelegramConnectionInput extends TelegramOwner {
  created_by_subject: CreatedBySubject;
  bot_token: string;
  bot_id: string;
  bot_name: string;
  bot_username: string | null;
  transport: 'polling' | 'webhook';
  webhook_secret: string | null;
  /** Defaults to now. */
  now?: Date;
}

export interface StartTelegramPairingInput extends TelegramOwner {
  code: string;
  expires_at: Date;
  telegram_user_id: string;
  chat_id: string;
  /** The waiting person's name as Telegram shows it, kept so Settings can name who would be paired. */
  display_name: string;
  /** Defaults to now. */
  now?: Date;
}

export interface AddTelegramPendingReplyInput extends TelegramOwner {
  connection_id: string;
  session_id: string;
  turn_id: string;
  chat_id: string;
  /** Defaults to now. */
  now?: Date;
}

export interface AddTelegramPendingApprovalInput extends TelegramOwner {
  connection_id: string;
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  chat_id: string;
  prompt: string;
  expires_at: string | null;
  /** Defaults to now. */
  now?: Date;
}

export interface ITelegramStore {
  /** The owner's connection, or undefined when no bot is connected. */
  getConnection(owner: TelegramOwner): Promise<TelegramConnection | undefined>;
  /** One connection by id, for the loops and endpoints that are handed an id they did not choose. */
  getConnectionById(input: { id: string }): Promise<TelegramConnection | undefined>;
  /** The connection a webhook secret belongs to, or undefined when no connection uses it. */
  getConnectionByWebhookSecret(input: { webhook_secret: string }): Promise<TelegramConnection | undefined>;
  /** Every connection, for the controller loops. One instance holds one owner, but the store does not assume it. */
  listConnections(): Promise<TelegramConnection[]>;
  /**
   * Saves a freshly checked bot as the owner's connection, replacing any earlier one and clearing
   * its pairing, pending replies and pending approvals: a new bot starts unpaired.
   */
  saveConnection(input: SaveTelegramConnectionInput): Promise<TelegramConnection>;
  /** Removes the owner's connection and everything waiting on it. Resolves to whether one was there. */
  deleteConnection(owner: TelegramOwner): Promise<boolean>;
  /** Records the code a /start produced, and who sent it, until it is confirmed or expires. */
  startPairing(input: StartTelegramPairingInput): Promise<void>;
  /**
   * Makes the pairing waiting under `code` the connection's pairing and clears the code, in one
   * write that lands only while that code is still the waiting one. Resolves to whether anyone
   * was paired: a /start that replaced the code in the meantime leaves the write unmatched, so
   * a stale code can never pair whoever is waiting now.
   */
  confirmPairing(input: TelegramOwner & { code: string; now?: Date }): Promise<boolean>;
  /** Drops a waiting code without pairing anyone. */
  clearPairing(owner: TelegramOwner & { now?: Date }): Promise<void>;
  /**
   * Claims one update for handling, in one write that lands only when its id is past the last
   * claimed one. Resolves to whether the caller claimed it: Telegram can deliver the same update
   * twice (a slow poll answer, a webhook retry), and only the first claim is handled.
   */
  claimUpdate(input: { connection_id: string; update_id: string; now?: Date }): Promise<boolean>;
  /** Remembers where polling got to, so a restart does not re-read updates it already handed over. */
  setPollOffset(input: TelegramOwner & { poll_offset: string; now?: Date }): Promise<void>;
  /** Remembers the dedicated Telegram chat once it exists. */
  setSessionId(input: TelegramOwner & { session_id: string; now?: Date }): Promise<void>;
  /** Notes a turn whose answer Telegram is owed. One row per turn: a repeat note changes nothing. */
  addPendingReply(input: AddTelegramPendingReplyInput): Promise<void>;
  /** Replies still owed, oldest first. */
  listPendingReplies(input: { limit: number }): Promise<TelegramPendingReply[]>;
  /** Removes one reply's row: the reply pass clears it before sending, so a crash cannot send twice. */
  deletePendingReply(input: { id: string }): Promise<void>;
  /** Notes one held action offered as buttons. Resolves to the row, whose id the buttons carry. */
  addPendingApproval(input: AddTelegramPendingApprovalInput): Promise<TelegramPendingApproval>;
  /** One pending approval by the id its buttons carry. */
  getPendingApproval(input: { id: string }): Promise<TelegramPendingApproval | undefined>;
  /** Removes one pending approval, answered or given up on. */
  deletePendingApproval(input: { id: string }): Promise<void>;
}

/**
 * The stored subject arrives as JSON text from Postgres and already parsed from SQLite, whose
 * client parses this column name itself; both shapes mean the same subject.
 */
function parseStoredSubject(value: string | CreatedBySubject): CreatedBySubject {
  return CreatedBySubjectSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function toConnection(row: TelegramConnectionTable): TelegramConnection {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_by_subject: parseStoredSubject(row.created_by_subject),
    bot_token: row.bot_token,
    bot_id: row.bot_id,
    bot_name: row.bot_name,
    bot_username: row.bot_username,
    paired_telegram_user_id: row.paired_telegram_user_id,
    paired_chat_id: row.paired_chat_id,
    pairing_code: row.pairing_code,
    pairing_expires_at: toIsoOrNull(row.pairing_expires_at),
    pairing_telegram_user_id: row.pairing_telegram_user_id,
    pairing_chat_id: row.pairing_chat_id,
    pairing_display_name: row.pairing_display_name,
    last_update_id: row.last_update_id,
    poll_offset: row.poll_offset,
    transport: row.transport === 'webhook' ? 'webhook' : 'polling',
    webhook_secret: row.webhook_secret,
    session_id: row.session_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toPendingReply(row: TelegramPendingReplyTable): TelegramPendingReply {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    connection_id: row.connection_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    chat_id: row.chat_id,
    created_at: toIso(row.created_at),
  };
}

function toPendingApproval(row: TelegramPendingApprovalTable): TelegramPendingApproval {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    connection_id: row.connection_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    thread_id: row.thread_id,
    tool_call_id: row.tool_call_id,
    chat_id: row.chat_id,
    prompt: row.prompt,
    expires_at: toIsoOrNull(row.expires_at),
    created_at: toIso(row.created_at),
  };
}

export class TelegramStore implements ITelegramStore {
  readonly #db: Kysely<TelegramDatabase>;

  constructor(db: Kysely<TelegramDatabase>) {
    this.#db = db;
  }

  async getConnection(owner: TelegramOwner): Promise<TelegramConnection | undefined> {
    const row = await this.#db
      .selectFrom('telegram_connection')
      .selectAll()
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : toConnection(row);
  }

  async getConnectionById(input: { id: string }): Promise<TelegramConnection | undefined> {
    const row = await this.#db
      .selectFrom('telegram_connection')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toConnection(row);
  }

  async getConnectionByWebhookSecret(input: { webhook_secret: string }): Promise<TelegramConnection | undefined> {
    const row = await this.#db
      .selectFrom('telegram_connection')
      .selectAll()
      .where('webhook_secret', '=', input.webhook_secret)
      .executeTakeFirst();
    return row === undefined ? undefined : toConnection(row);
  }

  async listConnections(): Promise<TelegramConnection[]> {
    const rows = await this.#db.selectFrom('telegram_connection').selectAll().orderBy('created_at', 'asc').execute();
    return rows.map(toConnection);
  }

  async saveConnection(input: SaveTelegramConnectionInput): Promise<TelegramConnection> {
    const now = (input.now ?? new Date()).toISOString();
    const owner = { tenant_id: input.tenant_id, created_by: input.created_by };
    const existing = await this.getConnection(owner);
    await this.#deleteWaiting(owner);
    if (existing !== undefined) {
      await this.#db.deleteFrom('telegram_connection').where('id', '=', existing.id).execute();
    }
    const row: TelegramConnectionTable = {
      id: newId(),
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      created_by_subject: JSON.stringify(input.created_by_subject),
      bot_token: input.bot_token,
      bot_id: input.bot_id,
      bot_name: input.bot_name,
      bot_username: input.bot_username,
      paired_telegram_user_id: null,
      paired_chat_id: null,
      pairing_code: null,
      pairing_expires_at: null,
      pairing_telegram_user_id: null,
      pairing_chat_id: null,
      pairing_display_name: null,
      last_update_id: null,
      poll_offset: null,
      transport: input.transport,
      webhook_secret: input.webhook_secret,
      session_id: null,
      created_at: now,
      updated_at: now,
    };
    await this.#db.insertInto('telegram_connection').values(row).execute();
    return toConnection(row);
  }

  async deleteConnection(owner: TelegramOwner): Promise<boolean> {
    await this.#deleteWaiting(owner);
    const result = await this.#db
      .deleteFrom('telegram_connection')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async #deleteWaiting(owner: TelegramOwner): Promise<void> {
    await this.#db
      .deleteFrom('telegram_pending_reply')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
    await this.#db
      .deleteFrom('telegram_pending_approval')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }

  async startPairing(input: StartTelegramPairingInput): Promise<void> {
    await this.#db
      .updateTable('telegram_connection')
      .set({
        pairing_code: input.code,
        pairing_expires_at: input.expires_at.toISOString(),
        pairing_telegram_user_id: input.telegram_user_id,
        pairing_chat_id: input.chat_id,
        pairing_display_name: input.display_name,
        updated_at: (input.now ?? new Date()).toISOString(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .execute();
  }

  async confirmPairing(input: TelegramOwner & { code: string; now?: Date }): Promise<boolean> {
    // One conditional write: the waiting person becomes the pairing only while the code being
    // confirmed is still the stored one. A /start that landed after the code was read replaced
    // the code, so this matches nothing and pairs nobody.
    const result = await this.#db
      .updateTable('telegram_connection')
      .set({
        paired_telegram_user_id: sql<string>`pairing_telegram_user_id`,
        paired_chat_id: sql<string>`pairing_chat_id`,
        pairing_code: null,
        pairing_expires_at: null,
        pairing_telegram_user_id: null,
        pairing_chat_id: null,
        pairing_display_name: null,
        updated_at: (input.now ?? new Date()).toISOString(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('pairing_code', '=', input.code)
      .where('pairing_telegram_user_id', 'is not', null)
      .where('pairing_chat_id', 'is not', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async clearPairing(owner: TelegramOwner & { now?: Date }): Promise<void> {
    await this.#db
      .updateTable('telegram_connection')
      .set({
        pairing_code: null,
        pairing_expires_at: null,
        pairing_telegram_user_id: null,
        pairing_chat_id: null,
        pairing_display_name: null,
        updated_at: (owner.now ?? new Date()).toISOString(),
      })
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }

  async claimUpdate(input: { connection_id: string; update_id: string; now?: Date }): Promise<boolean> {
    // One conditional write: the id is recorded only when it is past the last claimed one, so
    // two deliveries of the same update can never both be claimed.
    const result = await this.#db
      .updateTable('telegram_connection')
      .set({ last_update_id: input.update_id, updated_at: (input.now ?? new Date()).toISOString() })
      .where('id', '=', input.connection_id)
      .where(
        sql<boolean>`(last_update_id is null or cast(last_update_id as bigint) < cast(${input.update_id} as bigint))`,
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setPollOffset(input: TelegramOwner & { poll_offset: string; now?: Date }): Promise<void> {
    await this.#db
      .updateTable('telegram_connection')
      .set({ poll_offset: input.poll_offset, updated_at: (input.now ?? new Date()).toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .execute();
  }

  async setSessionId(input: TelegramOwner & { session_id: string; now?: Date }): Promise<void> {
    await this.#db
      .updateTable('telegram_connection')
      .set({ session_id: input.session_id, updated_at: (input.now ?? new Date()).toISOString() })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .execute();
  }

  async addPendingReply(input: AddTelegramPendingReplyInput): Promise<void> {
    const existing = await this.#db
      .selectFrom('telegram_pending_reply')
      .select('id')
      .where('turn_id', '=', input.turn_id)
      .executeTakeFirst();
    if (existing !== undefined) {
      return;
    }
    await this.#db
      .insertInto('telegram_pending_reply')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        connection_id: input.connection_id,
        session_id: input.session_id,
        turn_id: input.turn_id,
        chat_id: input.chat_id,
        created_at: (input.now ?? new Date()).toISOString(),
      })
      .execute();
  }

  async listPendingReplies(input: { limit: number }): Promise<TelegramPendingReply[]> {
    const rows = await this.#db
      .selectFrom('telegram_pending_reply')
      .selectAll()
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(toPendingReply);
  }

  async deletePendingReply(input: { id: string }): Promise<void> {
    await this.#db.deleteFrom('telegram_pending_reply').where('id', '=', input.id).execute();
  }

  async addPendingApproval(input: AddTelegramPendingApprovalInput): Promise<TelegramPendingApproval> {
    const row: TelegramPendingApprovalTable = {
      id: newId(),
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      connection_id: input.connection_id,
      session_id: input.session_id,
      turn_id: input.turn_id,
      thread_id: input.thread_id,
      tool_call_id: input.tool_call_id,
      chat_id: input.chat_id,
      prompt: input.prompt,
      expires_at: input.expires_at,
      created_at: (input.now ?? new Date()).toISOString(),
    };
    await this.#db.insertInto('telegram_pending_approval').values(row).execute();
    return toPendingApproval(row);
  }

  async getPendingApproval(input: { id: string }): Promise<TelegramPendingApproval | undefined> {
    const row = await this.#db
      .selectFrom('telegram_pending_approval')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPendingApproval(row);
  }

  async deletePendingApproval(input: { id: string }): Promise<void> {
    await this.#db.deleteFrom('telegram_pending_approval').where('id', '=', input.id).execute();
  }
}
