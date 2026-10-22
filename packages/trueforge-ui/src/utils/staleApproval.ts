import { apiErrorCode } from './apiErrorCode.js';

/**
 * The server refuses an approval answered after the chat moved on, or one whose request ended (409
 * with one of these `error.code`s). Nothing was approved or run, so the UI says so in plain words
 * and reloads the chat.
 */
const STALE_APPROVAL_CODES: ReadonlySet<string> = new Set(['stale_approval_continuation', 'approval_request_ended']);

export const EXPIRED_REQUEST_TITLE = 'This request expired';
export const EXPIRED_REQUEST_DESCRIPTION =
  'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.';

export function isStaleApprovalError(error: unknown): boolean {
  const detail = apiErrorCode(error);
  return detail?.statusCode === 409 && typeof detail.code === 'string' && STALE_APPROVAL_CODES.has(detail.code);
}

type StaleApprovalListener = () => void;

const staleApprovalListeners = new Set<StaleApprovalListener>();

/** Subscribe to "an approval was refused as stale" signals; the chat reloads so old cards disappear. */
export function subscribeToStaleApproval(listener: StaleApprovalListener): () => void {
  staleApprovalListeners.add(listener);
  return () => {
    staleApprovalListeners.delete(listener);
  };
}

export function publishStaleApproval(): void {
  for (const listener of staleApprovalListeners) {
    listener();
  }
}
