import type { OutboundEventKind, OutboundEventWriter } from '@truefoundry/trueforge-core/core';

export interface OutboundEventRecord {
  id: string;
  kind: OutboundEventKind;
  host: string;
  model: string | null;
  tool_name: string | null;
  request_bytes: number | null;
  recipient_count: number | null;
  subject: string | null;
  conversation_id: string | null;
  /** ISO-8601 UTC instant. */
  created_at: string;
}

export interface ListOutboundEventsInput {
  tenant_id: string;
  since: Date;
  limit: number;
}

/**
 * Durable record of requests that left this computer. Rows hold hosts and sizes only, so the table
 * can be shown to the owner as is.
 */
export interface IOutboundEventStore extends OutboundEventWriter {
  /** Events at or after `since`, newest first. */
  listSince(input: ListOutboundEventsInput): Promise<OutboundEventRecord[]>;
  /** Removes events older than `before`; returns how many. */
  deleteBefore(input: { before: Date }): Promise<number>;
}
