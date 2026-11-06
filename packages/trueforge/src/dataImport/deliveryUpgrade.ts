import { DeliveryAttemptSchema } from '../schemas/deliveries';
import { LEFT_OUT } from './importSchemas';
import { isRecord, noteLeftOut } from './lenient';

/** What an older export says when it never recorded why an item reached the person. */
export const UNRECORDED_REASON = 'This came from an earlier export, which did not say why you got it.';

/** The label the person is told about when a channel attempt could not be read. */
export const DELIVERY_ATTEMPT_LEFT_OUT = LEFT_OUT.deliveryAttempt;

function defaultLevel(kind: unknown): 'note' | 'nudge' {
  return kind === 'note' ? 'note' : 'nudge';
}

/** Keeps the channel attempts that still read; each one that does not is counted, never invented. */
function readableAttempts(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: unknown[] = raw;
  const kept = items.filter(item => DeliveryAttemptSchema.safeParse(item).success);
  noteLeftOut({ label: DELIVERY_ATTEMPT_LEFT_OUT, count: items.length - kept.length });
  return kept;
}

/**
 * Brings a deliveries section from an older export up to today's shape before the strict read. Text, kind,
 * link and times are what people see, so they are never repaired: a record that lacks them fails the import.
 * Later fields an older export did not have get a plain default, and attempts are internal detail.
 */
export function upgradeArchivedDeliveries(json: unknown): unknown {
  if (!Array.isArray(json)) {
    return json;
  }
  const records: unknown[] = json;
  return records.map(record => {
    if (!isRecord(record)) {
      return record;
    }
    return {
      ...record,
      level: record['level'] ?? defaultLevel(record['kind']),
      reason: record['reason'] ?? UNRECORDED_REASON,
      seen_at: record['seen_at'] ?? null,
      link: record['link'] ?? null,
      attempts: readableAttempts(record['attempts']),
    };
  });
}
