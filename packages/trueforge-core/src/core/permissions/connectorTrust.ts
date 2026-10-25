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

/**
 * A call the host itself vouches for: standing trust, or a read of the operator's own mail. The default gate on tools
 * that publish no annotations does not apply to it; a gate list the person chose still does.
 */
export function isHostVouchedDecision(decision: TierDecision): boolean {
  return isStandingTrustDecision(decision) || (decision.tier === 1 && decision.reason === MAIL_READ_REASON);
}

export function isStandingTrustDecision(decision: TierDecision): boolean {
  return (
    decision.tier === 1 &&
    (decision.reason === FIRST_PARTY_TOOL_REASON ||
      decision.reason === TOOL_GRANT_REASON ||
      isSilentSearchReason(decision.reason))
  );
}
