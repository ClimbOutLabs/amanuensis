// No imports: the app reads this module from source too.

/** Minutes a request for the person's OK waits before the app closes it unanswered. */
export const APPROVAL_EXPIRY_MINUTES = 30;

// The words predate this module; they stay the same so cards closed by older app versions read as expired too.
const APPROVAL_EXPIRED_REASON = `Automatically denied: the approval was not answered within ${String(APPROVAL_EXPIRY_MINUTES)} minutes.`;

/** The denial reason the app sends for a card nobody answered in time. It is not the person's answer. */
export function approvalExpiredReason(): string {
  return APPROVAL_EXPIRED_REASON;
}

/** The stable code for an expired card: its activity row's reason and its tool result's remediation. */
export const APPROVAL_EXPIRED_REASON_CODE = 'approval_expired';

/** True for a card the app closed because nobody answered it in time. */
export function isApprovalExpiredReason(reason: string | undefined): boolean {
  return reason === APPROVAL_EXPIRED_REASON;
}

/** True for a decision the app recorded for a card nobody answered in time. */
export function isExpiredApproval(decision: { status: string; reason?: string | undefined } | undefined): boolean {
  return decision?.status === 'deny' && isApprovalExpiredReason(decision.reason);
}

/** The result the model reads for a call whose card expired. Nothing ran, and the person did not say no. */
export const APPROVAL_EXPIRED_RESULT =
  "Nothing was done: the request for the person's OK went unanswered and expired. They did not say no. Tell them it expired and ask if they still want it.";
