import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { SessionEventItem, TurnDoneMetrics, TurnState, TurnStreamingEvent } from '../../server/types.js';

/** SDK token fields are optional; the UI contract requires numbers. Keep cost for session tiles. */
export function toUiTurnDoneMetrics(metrics: TrueForgeApi.TurnMetrics): TurnDoneMetrics & { totalCostInUsd?: number } {
  return {
    totalInputTokens: metrics.totalInputTokens ?? 0,
    totalOutputTokens: metrics.totalOutputTokens ?? 0,
    totalTokens: metrics.totalTokens ?? 0,
    totalCacheReadTokens: metrics.totalCacheReadTokens ?? 0,
    totalCacheWriteTokens: metrics.totalCacheWriteTokens ?? 0,
    totalReasoningTokens: metrics.totalReasoningTokens ?? 0,
    ...(metrics.totalCostInUsd == null ? {} : { totalCostInUsd: metrics.totalCostInUsd }),
  };
}

export function toUiTurnState(state: TrueForgeApi.TurnState | TrueForgeApi.TurnDoneEventState): TurnState {
  return state.status === 'running' ? { status: 'running' } : toUiTerminalTurnState(state);
}

function toUiTerminalTurnState(state: TrueForgeApi.TurnDoneEventState): Exclude<TurnState, { status: 'running' }> {
  switch (state.status) {
    case 'cancelled':
      return { status: 'cancelled', reason: state.reason, completedAt: state.completedAt };
    case 'error':
      return { status: 'error', message: state.message, completedAt: state.completedAt };
    case 'done':
      return {
        status: 'done',
        completedAt: state.completedAt,
        requiredActions: state.requiredActions,
        ...(state.output == null ? {} : { output: state.output }),
        ...(state.metrics == null ? {} : { metrics: toUiTurnDoneMetrics(state.metrics) }),
      };
  }
}

/**
 * Passthrough event types the vendor `@truefoundry/assistant-ui-runtime` union has no ingestion
 * case for (see the callers' comments for why each is excluded). `toUiSessionEvent` and
 * `toUiStreamingEvent` only ever spread their input into a vendor-shaped event, so their
 * parameter types are narrowed to exclude these up front — carrying the caller's own exclusion
 * checks (already required to reach these functions) into the type system instead of casting.
 */
export type VendorIncompatibleEventType =
  | 'tool.execution_started'
  | 'aman.memory.recall'
  | 'aman.profile.learned'
  | 'aman.skill.used'
  | 'aman.sandbox.provisioning'
  | 'aman.model.usage'
  | 'agent.context.compaction'
  | 'document.ingestion';

const INCOMPATIBLE_EVENT_TYPES: readonly string[] = [
  'tool.execution_started',
  'aman.memory.recall',
  'aman.profile.learned',
  'aman.skill.used',
  'aman.sandbox.provisioning',
  'aman.model.usage',
  'agent.context.compaction',
  'document.ingestion',
];

/**
 * Type guard for the vendor-typed event unions. The vendor types omit `aman.skill.used`
 * (host skill-telemetry) even though it arrives at runtime, so a direct `event.type ===`
 * comparison fails type-checking. This runtime check with a type predicate narrows soundly
 * without assertion escapes.
 */
export function isCompatibleSessionEvent(
  event: TrueForgeApi.SessionEvent,
): event is Exclude<TrueForgeApi.SessionEvent, { type: VendorIncompatibleEventType }> {
  return !INCOMPATIBLE_EVENT_TYPES.includes(event.type);
}

export function isCompatibleStreamingEvent(
  event: TrueForgeApi.TurnStreamingEvent,
): event is Exclude<TrueForgeApi.TurnStreamingEvent, { type: VendorIncompatibleEventType }> {
  return !INCOMPATIBLE_EVENT_TYPES.includes(event.type);
}

export function toUiSessionEvent(
  event: Exclude<TrueForgeApi.SessionEvent, { type: VendorIncompatibleEventType }>,
): SessionEventItem['event'] {
  if (event.type !== 'turn.done') return { ...event };
  return { ...event, state: toUiTerminalTurnState(event.state) };
}

export function toUiStreamingEvent(
  event: Exclude<TrueForgeApi.TurnStreamingEvent, { type: VendorIncompatibleEventType }>,
): TurnStreamingEvent {
  if (event.type !== 'turn.done') return { ...event };
  return { ...event, state: toUiTerminalTurnState(event.state) };
}

/**
 * `AgentSessionsServer.listSessionEvents` (admin/metrics session-events read) is vendor-typed the
 * same as the chat port's `listEvents`, so it excludes the same passthrough events for the same
 * reason (see `toUiSessionEvent` above and `chatServer.ts`'s `toUiEventItem`).
 */
export function toUiEventItem(item: TrueForgeApi.SessionEventItem): SessionEventItem | undefined {
  // Filter vendor-incompatible passthrough events (tool execution markers, memory/profile/skill
  // telemetry, compaction notices, document ingestion) via the type guard — the vendor union
  // omits `aman.skill.used` even though it arrives at runtime.
  if (!isCompatibleSessionEvent(item.event)) {
    return undefined;
  }
  return { turnId: item.turnId, event: toUiSessionEvent(item.event) };
}

/**
 * Extracts the timestamp marker for `aman.memory.recall` events.
 * The session timeline uses this to attribute recall duration correctly:
 * the model bar starts when the lookup finishes, not when the turn started.
 * Returns undefined for non-recall events.
 *
 * This is a separate path from `toUiEventItem` (which filters recall out)
 * because `SessionEventItem` (external server contract) has no shape for
 * passthrough recall events. The timeline receives these markers via a
 * dedicated prop rather than the events array.
 */
export function extractRecallTimestamp(item: TrueForgeApi.SessionEventItem):
  | {
      turnId: string;
      timestamp: string;
    }
  | undefined {
  if (item.event.type !== 'aman.memory.recall') return undefined;
  return {
    turnId: item.turnId,
    timestamp: item.event.createdAt,
  };
}
