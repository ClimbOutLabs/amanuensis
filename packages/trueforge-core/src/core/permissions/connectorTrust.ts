/**
 * Calls a connector tool runs without a card because of trust the host already holds, not a
 * decision on that call. They are audited once at dispatch, never at classification, because the
 * same call is classified several times on its way there.
 */
import type { TierDecision } from './tier';
import { TOOL_GRANT_REASON } from './toolGrants';

/** The connector is first-party and the tool declares itself read-only and explicitly closed-world. */
export const FIRST_PARTY_TOOL_REASON = 'mcp_first_party_read_only';

export function isStandingTrustDecision(decision: TierDecision): boolean {
  return decision.tier === 1 && (decision.reason === FIRST_PARTY_TOOL_REASON || decision.reason === TOOL_GRANT_REASON);
}
