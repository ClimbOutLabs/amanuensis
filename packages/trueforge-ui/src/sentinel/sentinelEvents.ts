import type { SentinelApprovalInfo, SentinelSendReceipt } from './types.js';

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

export type SendReceiptListener = (receipt: SentinelSendReceipt) => void;

const receiptListeners = new Set<SendReceiptListener>();

/** Send receipts ride the same raw stream tap as approvals, for the same reason. */
export function subscribeToSendReceipts(listener: SendReceiptListener): () => void {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
}

export function publishSendReceipt(receipt: SentinelSendReceipt): void {
  for (const listener of receiptListeners) {
    listener(receipt);
  }
}

/** Test helper: drops every subscriber so suites do not leak listeners. */
export function clearSentinelEventSubscribers(): void {
  listeners.clear();
  receiptListeners.clear();
}
