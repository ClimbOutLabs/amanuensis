/**
 * The server refuses an approval answered after the chat moved on (409 with this `error.code`).
 * Nothing was approved or run, so the UI says so in plain words and reloads the chat.
 */
const STALE_APPROVAL_CODE = 'stale_approval_continuation';

export const EXPIRED_REQUEST_TITLE = 'This request expired';
export const EXPIRED_REQUEST_DESCRIPTION =
  'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

export function isStaleApprovalError(error: unknown): boolean {
  if (!(error instanceof Error) || Reflect.get(error, 'statusCode') !== 409) return false;
  const body: unknown = Reflect.get(error, 'body');
  const detail = isRecord(body) ? body.error : undefined;
  return isRecord(detail) && detail.code === STALE_APPROVAL_CODE;
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
