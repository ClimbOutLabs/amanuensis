import type { SentinelApprovalInfo, Tier2Notice } from './types.js';

/**
 * Push-only, in-memory fan-out for Sentinel events observed on the live turn SSE
 * stream. `chatServer.ts` taps `tool.approval_required` / `tool.tier2_notice` off the
 * raw stream item before the vendor-typed pipeline narrows them away, and publishes
 * the parsed per-tool-call payloads here. `SentinelStateProvider` subscribes; the
 * durable complement is `SentinelApi.listSentinelSessionContext`, which rebuilds the
 * same state from persisted events after a reload.
 */
export type SentinelLiveEvent =
  | { kind: 'approval'; info: SentinelApprovalInfo }
  | { kind: 'notice'; notice: Tier2Notice };

export type SentinelListener = (event: SentinelLiveEvent) => void;

const listeners = new Set<SentinelListener>();

export function subscribeToSentinelEvents(listener: SentinelListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSentinelEvent(event: SentinelLiveEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

/** Test helper: drops every subscriber so suites do not leak listeners. */
export function clearSentinelEventSubscribers(): void {
  listeners.clear();
}
