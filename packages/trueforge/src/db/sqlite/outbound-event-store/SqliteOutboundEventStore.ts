import type { OutboundEventInput } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';

import { newId } from '../../../utils/id';
import type { IOutboundEventStore, ListOutboundEventsInput, OutboundEventRecord } from '../../outboundEventStore';
import type { Database, OutboundEventTable } from '../types';

function toRecord(row: OutboundEventTable): OutboundEventRecord {
  return {
    id: row.id,
    kind: row.kind,
    host: row.host,
    model: row.model,
    tool_name: row.tool_name,
    request_bytes: row.request_bytes,
    recipient_count: row.recipient_count,
    subject: row.subject,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
  };
}

export class SqliteOutboundEventStore implements IOutboundEventStore {
  readonly #db: Kysely<Database>;
  readonly #now: () => Date;

  /** `now` stamps each row; tests pass a fixed clock. */
  constructor(db: Kysely<Database>, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async record(input: OutboundEventInput): Promise<void> {
    await this.#db
      .insertInto('outbound_event')
      .values({ id: newId(), ...input, created_at: this.#now().toISOString() })
      .execute();
  }

  async listSince(input: ListOutboundEventsInput): Promise<OutboundEventRecord[]> {
    const rows = await this.#db
      .selectFrom('outbound_event')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_at', '>=', input.since.toISOString())
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toRecord);
  }

  async deleteBefore(input: { before: Date }): Promise<number> {
    const result = await this.#db
      .deleteFrom('outbound_event')
      .where('created_at', '<', input.before.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
