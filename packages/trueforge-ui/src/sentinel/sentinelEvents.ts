import type { SentinelApprovalInfo } from './types.js';

/**
 * Push-only, in-memory fan-out for Sentinel approvals observed on the live turn SSE
 * stream. `chatServer.ts` taps `tool.approval_required` off the raw stream item before
 * the vendor-typed pipeline narrows it away, and publishes the parsed per-tool-call
 * payloads here. `SentinelStateProvider` subscribes; the durable complement is
 * `SentinelApi.listSentinelSessionContext`, which rebuilds the same state from
 * persisted events after a reload.
 */
export type SentinelListener = (info: SentinelApprovalInfo) => void;

const listeners = new Set<SentinelListener>();

export function subscribeToSentinelEvents(listener: SentinelListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSentinelEvent(info: SentinelApprovalInfo): void {
  for (const listener of listeners) {
    listener(info);
  }
}

/** Test helper: drops every subscriber so suites do not leak listeners. */
export function clearSentinelEventSubscribers(): void {
  listeners.clear();
}
