import { decodePageToken, encodePageToken } from '@truefoundry/trueforge-core/agent-session/store/PageToken';
import type { AuditLogWriter, AuditOutcome, AuditRecordInput } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { newId } from '../utils/id';

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface SentinelAuditDatabase {
  session: {
    tenant_id: string;
    session_id: string;
  };
  sentinel_audit: {
    id: string;
    tenant_id: string;
    created_by: string;
    conversation_id: string;
    tier: number;
    tool_name: string;
    description: string;
    outcome: AuditOutcome;
    auto_deny_reason: string | null;
    created_at: string | Date;
  };
}

export interface SentinelAuditRecord {
  id: string;
  conversation_id: string;
  tier: number;
  tool_name: string;
  description: string;
  outcome: AuditOutcome;
  auto_deny_reason: string | null;
  created_at: string;
}

export interface ListOwnedSentinelAuditInput {
  tenant_id: string;
  created_by: string;
  limit: number;
  offset: number;
}

export interface ImportSentinelAuditInput {
  tenant_id: string;
  created_by: string;
  records: readonly SentinelAuditRecord[];
}

export interface ListSentinelAuditInput {
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  limit: number;
  offset: number;
}

export interface ListUserSentinelAuditInput {
  tenant_id: string;
  created_by: string;
  /** Only entries with this outcome; every outcome when undefined. */
  outcome: AuditOutcome | undefined;
  limit: number;
  /** Opaque token from a previous page; first page when undefined. */
  page_token: string | undefined;
}

export interface UserSentinelAuditRecord extends SentinelAuditRecord {
  /** False once the chat the entry came from has been deleted. */
  chat_exists: boolean;
}

export interface UserSentinelAuditPage {
  entries: UserSentinelAuditRecord[];
  next_page_token: string | undefined;
}

// Keyset position of the last entry served; `id` breaks ties between equal timestamps.
const UserAuditCursorSchema = z.object({ created_at: z.string(), id: z.string() });

function toRecord(row: SentinelAuditDatabase['sentinel_audit']): SentinelAuditRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tier: row.tier,
    tool_name: row.tool_name,
    description: row.description,
    outcome: row.outcome,
    auto_deny_reason: row.auto_deny_reason,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Public API of the Sentinel audit store, for wiring without generic parameters. */
export interface ISentinelAuditStore extends AuditLogWriter {
  list(input: ListSentinelAuditInput): Promise<SentinelAuditRecord[]>;
  /** Every chat's entries for one user, newest first, including chats since deleted. */
  listForUser(input: ListUserSentinelAuditInput): Promise<UserSentinelAuditPage>;
  /** Every row one owner has, oldest first, for the data export. */
  listOwned(input: ListOwnedSentinelAuditInput): Promise<SentinelAuditRecord[]>;
  /** Writes exported rows under the importing owner with their original dates; pass the import transaction. */
  importRecords(input: ImportSentinelAuditInput, transaction?: Kysely<SentinelAuditDatabase>): Promise<void>;
}

/** Rows written per insert statement; keeps each statement under the parameter limit of either database. */
const IMPORT_BATCH_SIZE = 50;

/**
 * Durable Sentinel permission audit log. Implements the AuditLogWriter
 * contract from trueforge-core so classification decisions are persisted,
 * and exposes per-chat and per-user listings for the audit routes.
 */
export class SentinelAuditStore implements ISentinelAuditStore {
  readonly #db: Kysely<SentinelAuditDatabase>;

  constructor(db: Kysely<SentinelAuditDatabase>) {
    this.#db = db;
  }

  async record(input: AuditRecordInput): Promise<void> {
    await this.#db
      .insertInto('sentinel_audit')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        conversation_id: input.conversation_id,
        tier: input.tier,
        tool_name: input.tool_name,
        description: input.description,
        outcome: input.outcome,
        auto_deny_reason: input.auto_deny_reason,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  async list(input: ListSentinelAuditInput): Promise<SentinelAuditRecord[]> {
    const rows = await this.#db
      .selectFrom('sentinel_audit')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('conversation_id', '=', input.conversation_id)
      .orderBy('created_at', 'desc')
      .limit(input.limit)
      .offset(input.offset)
      .execute();
    return rows.map(toRecord);
  }

  async listForUser(input: ListUserSentinelAuditInput): Promise<UserSentinelAuditPage> {
    const cursor =
      input.page_token === undefined ? undefined : decodePageToken(UserAuditCursorSchema, input.page_token);
    let query = this.#db
      .selectFrom('sentinel_audit')
      .leftJoin('session', join =>
        join
          .onRef('session.tenant_id', '=', 'sentinel_audit.tenant_id')
          .onRef('session.session_id', '=', 'sentinel_audit.conversation_id'),
      )
      .selectAll('sentinel_audit')
      .select('session.session_id as joined_session_id')
      .where('sentinel_audit.tenant_id', '=', input.tenant_id)
      .where('sentinel_audit.created_by', '=', input.created_by);
    if (input.outcome !== undefined) {
      query = query.where('sentinel_audit.outcome', '=', input.outcome);
    }
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('sentinel_audit.created_at', '<', cursor.created_at),
          eb.and([eb('sentinel_audit.created_at', '=', cursor.created_at), eb('sentinel_audit.id', '<', cursor.id)]),
        ]),
      );
    }
    // One extra row tells whether another page exists.
    const rows = await query
      .orderBy('sentinel_audit.created_at', 'desc')
      .orderBy('sentinel_audit.id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const entries = rows.slice(0, input.limit).map(row => ({
      ...toRecord(row),
      chat_exists: row.joined_session_id !== null,
    }));
    const last = entries.at(-1);
    return {
      entries,
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(UserAuditCursorSchema, { created_at: last.created_at, id: last.id })
          : undefined,
    };
  }

  async listOwned(input: ListOwnedSentinelAuditInput): Promise<SentinelAuditRecord[]> {
    const rows = await this.#db
      .selectFrom('sentinel_audit')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .offset(input.offset)
      .execute();
    return rows.map(toRecord);
  }

  async importRecords(input: ImportSentinelAuditInput, transaction?: Kysely<SentinelAuditDatabase>): Promise<void> {
    const db = transaction ?? this.#db;
    for (let start = 0; start < input.records.length; start += IMPORT_BATCH_SIZE) {
      const batch = input.records.slice(start, start + IMPORT_BATCH_SIZE);
      await db
        .insertInto('sentinel_audit')
        .values(
          batch.map(record => ({
            id: newId(),
            tenant_id: input.tenant_id,
            created_by: input.created_by,
            conversation_id: record.conversation_id,
            tier: record.tier,
            tool_name: record.tool_name,
            description: record.description,
            outcome: record.outcome,
            auto_deny_reason: record.auto_deny_reason,
            created_at: record.created_at,
          })),
        )
        .execute();
    }
  }
}
