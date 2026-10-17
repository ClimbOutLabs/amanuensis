import type { OutboundEvent, OutboundEventKind } from './types.js';

/** A list longer than this folds repeated model requests into one row per chat. */
export const OUTBOUND_GROUPING_THRESHOLD = 25;

export type OutboundRow =
  | { type: 'event'; event: OutboundEvent }
  | {
      type: 'model_requests';
      key: string;
      host: string;
      model: string | null;
      conversation_id: string | null;
      count: number;
      /** Sum of the measured request sizes; null when none was measured. */
      total_bytes: number | null;
      latest_at: string;
      earliest_at: string;
    };

/**
 * Rows to show, newest first. Every request stays its own row until the list is long; then the
 * model requests of one chat to one service and model fold into a single row with their count,
 * total size and time span. Other kinds are never folded.
 */
export function groupOutboundEvents(events: OutboundEvent[]): OutboundRow[] {
  if (events.length <= OUTBOUND_GROUPING_THRESHOLD) {
    return events.map(event => ({ type: 'event', event }));
  }
  const rows: OutboundRow[] = [];
  const groups = new Map<string, Extract<OutboundRow, { type: 'model_requests' }>>();
  for (const event of events) {
    if (event.kind !== ('model_request' satisfies OutboundEventKind)) {
      rows.push({ type: 'event', event });
      continue;
    }
    const key = JSON.stringify([event.conversation_id, event.host, event.model]);
    const group = groups.get(key);
    if (group === undefined) {
      const created: Extract<OutboundRow, { type: 'model_requests' }> = {
        type: 'model_requests',
        key,
        host: event.host,
        model: event.model,
        conversation_id: event.conversation_id,
        count: 1,
        total_bytes: event.request_bytes,
        latest_at: event.created_at,
        earliest_at: event.created_at,
      };
      groups.set(key, created);
      rows.push(created);
    } else {
      group.count += 1;
      group.total_bytes =
        event.request_bytes === null ? group.total_bytes : (group.total_bytes ?? 0) + event.request_bytes;
      group.earliest_at = event.created_at;
    }
  }
  return rows;
}
