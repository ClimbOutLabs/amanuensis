import { EventType, type PersistedTurnEvent } from '../schemas/events';

/**
 * The final answer for `threadId` among `events`, or undefined when the batch
 * carries none. A model message with no tool calls is the answer a turn
 * commits to; a model message carrying tool calls is an intermediate step.
 * Shared by every store backend and by the turn worker's routing, so all of
 * them agree on what counts as a final.
 */
export function findFinalAnswerEvent(
  events: readonly PersistedTurnEvent[],
  threadId: string,
): PersistedTurnEvent | undefined {
  return events.find(
    event =>
      event.type === EventType.MODEL_MESSAGE &&
      event.thread_id === threadId &&
      (event.tool_calls === undefined || event.tool_calls.length === 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (item === undefined ? null : sortForCanonicalJson(item)));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = value[key];
      if (field !== undefined) {
        sorted[key] = sortForCanonicalJson(field);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON encoding of a value: object keys sorted at every depth, with
 * JSON semantics for undefined (object fields drop out, array entries become
 * null). Two encodings of the same value produce the same string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

/** True when two persisted events carry the same content, key order aside. */
export function turnEventsEqual(a: PersistedTurnEvent, b: PersistedTurnEvent): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
