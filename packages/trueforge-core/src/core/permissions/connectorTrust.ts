/**
 * Calls a connector tool runs without a card because of trust the host already holds (including the
 * user's designated search provider), not a decision on that call. They are audited once at dispatch, never at classification, because the
 * same call is classified several times on its way there.
 */
import type { TierDecision } from './tier';
import { TOOL_GRANT_REASON } from './toolGrants';
import { isSilentSearchReason } from './webSearch';

/** The connector is first-party and the tool declares itself read-only and explicitly closed-world. */
export const FIRST_PARTY_TOOL_REASON = 'mcp_first_party_read_only';

/** A read of the operator's own Email sidecar, which runs without a card as Gmail's reads do. */
export const MAIL_READ_REASON = 'mail_read';

/** Reading mail with mark-as-read set: the read becomes a change, so it asks with its own card. */
export const MAIL_MARK_AS_READ_REASON = 'mail_mark_as_read';

/** A read of the operator's own Calendar sidecar, which runs without a card. */
export const CALDAV_PRIVATE_READ_REASON = 'caldav_private_read';

/** A send through the operator's own Email sidecar. It always asks, and approving it checks the Email list. */
export const MAIL_SEND_REASON = 'mail_send';

/** A send or a draft through the operator's own Email sidecar to an address not yet on the Email list. */
export const MAIL_NEW_RECIPIENT_REASON = 'mail_new_recipient';

/**
 * Reasons that mean the host itself judged a call a read it can safely make again: its own mail and calendar
 * reads, and a read on a connector it marked first-party. A connector's own read-only claim is not among them.
 */
const HOST_VOUCHED_READ_REASONS: ReadonlySet<string> = new Set([
  MAIL_READ_REASON,
  CALDAV_PRIVATE_READ_REASON,
  FIRST_PARTY_TOOL_REASON,
]);

export function isHostVouchedReadReason(reason: string | undefined): boolean {
  return reason !== undefined && HOST_VOUCHED_READ_REASONS.has(reason);
}

/**
 * A call the host itself vouches for: standing trust, or a read of the operator's own mail or calendar.
 * The default gate's read tags (@write and @unclassified) do not apply to it; a gate list the person
 * chose still does.
 */
export function isHostVouchedDecision(decision: TierDecision): boolean {
  return (
    isStandingTrustDecision(decision) ||
    (decision.tier === 1 && (decision.reason === MAIL_READ_REASON || decision.reason === CALDAV_PRIVATE_READ_REASON))
  );
}

export function isStandingTrustDecision(decision: TierDecision): boolean {
  return (
    decision.tier === 1 &&
    (decision.reason === FIRST_PARTY_TOOL_REASON ||
      decision.reason === TOOL_GRANT_REASON ||
      isSilentSearchReason(decision.reason))
  );
}
