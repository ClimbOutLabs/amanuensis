import type { z } from 'zod';
import type { PersistedPassthroughEvent } from '../schemas/events';
import { MEMORY_RECALL_EVENT_TYPE, MemoryRecallPersistedEventSchema } from '../schemas/memoryEvents';
import { MODEL_USAGE_EVENT_TYPE, ModelUsagePersistedEventSchema } from '../schemas/modelUsageEvents';
import { MODEL_WAITING_EVENT_TYPE, ModelWaitingPersistedEventSchema } from '../schemas/modelWaitingEvents';
import { PROFILE_LEARNED_EVENT_TYPE, ProfileLearnedPersistedEventSchema } from '../schemas/profileLearningEvents';
import { PROVISIONING_EVENT_TYPE, ProvisioningPersistedEventSchema } from '../schemas/provisionEvents';
import { SKILL_USED_EVENT_TYPE, SkillUsedPersistedEventSchema } from '../schemas/skillEvents';

/**
 * Durable event append for a turn that has already completed successfully.
 *
 * `ISessionStore.appendToEvents` fences every write on the turn still being `running`, which
 * is right for execution: terminal turns are immutable. Host-side passes that by design run
 * after the turn finishes (the learned-profile distillation pass) still need to leave their
 * audit row in the same event log the list routes read. This is that one deliberate, narrow
 * exception: it accepts rows only for turns whose terminal status is `done`, and only rows that
 * are registered passthrough audit events. Lifecycle, content, and tool events are refused, by
 * this type and again at runtime, so the listed history can never contradict the immutable turn
 * record.
 */
export interface AppendPassthroughEventsInput {
  session_id: string;
  turn_id: string;
  events: PersistedPassthroughEvent[];
}

export interface ICompletedTurnEventStore {
  appendEventsToDoneTurn(input: AppendPassthroughEventsInput): Promise<void>;
}

/**
 * What the backend query functions take, and the runtime boundary of the exception.
 *
 * Deliberately wider than {@link AppendPassthroughEventsInput}: every caller inside the host
 * reaches those queries through {@link ICompletedTurnEventStore}, which is narrow, and the wide
 * shape here is what gives {@link assertPassthroughAuditEvents} something to reject and what
 * lets the store contract suite prove it does.
 */
export interface AppendCompletedTurnEventsInput {
  session_id: string;
  turn_id: string;
  events: { type: string; id: string; created_at: string }[];
}

/**
 * The accepted event types, keyed to the schema that owns each one's shape. Keyed by
 * discriminator rather than held as a list so it stays exhaustive: registering a new passthrough
 * event widens {@link PersistedPassthroughEvent} and this object stops compiling until the new
 * type is listed here, with its schema, too.
 */
const PASSTHROUGH_AUDIT_EVENT_SCHEMAS: {
  [Type in PersistedPassthroughEvent['type']]: z.ZodType<Extract<PersistedPassthroughEvent, { type: Type }>>;
} = {
  [MEMORY_RECALL_EVENT_TYPE]: MemoryRecallPersistedEventSchema,
  [PROFILE_LEARNED_EVENT_TYPE]: ProfileLearnedPersistedEventSchema,
  [SKILL_USED_EVENT_TYPE]: SkillUsedPersistedEventSchema,
  [PROVISIONING_EVENT_TYPE]: ProvisioningPersistedEventSchema,
  [MODEL_USAGE_EVENT_TYPE]: ModelUsagePersistedEventSchema,
  [MODEL_WAITING_EVENT_TYPE]: ModelWaitingPersistedEventSchema,
};

function isRegisteredPassthroughEventType(type: string): type is PersistedPassthroughEvent['type'] {
  return Object.hasOwn(PASSTHROUGH_AUDIT_EVENT_SCHEMAS, type);
}

/**
 * Runtime half of the same narrowing, enforced by every backend before it inserts. The input
 * type above stops a TypeScript caller; this stops the ones it cannot see, and keeps the
 * exception as narrow at runtime as it reads on the interface.
 *
 * The whole event is checked, not just its discriminator: the list and stream routes parse what
 * they read against these same schemas, so a row that merely carries a registered `type` but is
 * missing or mistypes a payload field would persist and then break every read of the turn. One
 * bad event refuses the entire batch, before any backend opens its transaction.
 */
export function assertPassthroughAuditEvents(events: readonly { type: string }[]): void {
  for (const event of events) {
    if (!isRegisteredPassthroughEventType(event.type)) {
      throw new Error(
        `Turn event ${event.type} is not a registered passthrough audit event; a completed turn's event log accepts no other kind`,
      );
    }
    const result = PASSTHROUGH_AUDIT_EVENT_SCHEMAS[event.type].safeParse(event);
    if (!result.success) {
      const issues = result.error.issues
        .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Turn event ${event.type} is not a valid passthrough audit event: ${issues}`, {
        cause: result.error,
      });
    }
  }
}
