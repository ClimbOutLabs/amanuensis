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
type VendorIncompatibleEventType =
  | 'tool.execution_started'
  | 'aman.memory.recall'
  | 'aman.profile.learned'
  | 'agent.context.compaction'
  | 'document.ingestion';

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
  if (
    item.event.type === 'tool.execution_started' ||
    item.event.type === 'aman.memory.recall' ||
    item.event.type === 'aman.profile.learned' ||
    item.event.type === 'agent.context.compaction' ||
    item.event.type === 'document.ingestion'
  ) {
    return undefined;
  }
  return { turnId: item.turnId, event: toUiSessionEvent(item.event) };
}
