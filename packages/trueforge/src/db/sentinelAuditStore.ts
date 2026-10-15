import type { AuditLogWriter, AuditOutcome, AuditRecordInput } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';

import { newId } from '../utils/id';

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface SentinelAuditDatabase {
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

export interface ListSentinelAuditInput {
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  limit: number;
  offset: number;
}

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
}

/**
 * Durable Sentinel permission audit log. Implements the AuditLogWriter
 * contract from trueforge-core so classification decisions are persisted,
 * and exposes list() for the GET /api/v1/sessions/{id}/audit-log route.
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
}
