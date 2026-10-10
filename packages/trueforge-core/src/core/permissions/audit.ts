/**
 * Sentinel audit log writer contract. The durable append-only store lives in
 * the server package; this interface lets trueforge-core record entries
 * without importing server code. Classify-time entries are written before
 * the action executes; outcomes of approved or relaxed actions are written
 * after dispatch. Retention is bounded server-side (default 90 days).
 */
import type { SentinelCallIdentity, SentinelServices } from './context';
import type { AutoDenyReason, Tier, TierDecision } from './tier';

/** Recorded outcome, per tier. */
export type AuditOutcome = 'logged' | 'ran' | 'approved' | 'denied' | 'auto_denied';

export interface AuditRecordInput {
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  tier: Tier;
  tool_name: string;
  /** Plain-language description of the action. */
  description: string;
  outcome: AuditOutcome;
  auto_deny_reason: AutoDenyReason | null;
}

export interface AuditLogWriter {
  record(input: AuditRecordInput): Promise<void>;
}

/**
 * Record the classify-time audit entry: Tier 1 sensitive reads ('logged') and
 * Tier 3 auto-denials ('auto_denied'). Tier 2 and Tier 3 carded actions
 * record their outcome ('ran', 'approved', 'denied') after dispatch instead.
 * No-op when no audit writer is configured.
 */
export async function recordClassificationAudit(input: {
  services: SentinelServices;
  identity: SentinelCallIdentity;
  tool_name: string;
  decision: TierDecision;
}): Promise<void> {
  const writer = input.services.audit;
  if (writer === null) {
    return;
  }
  const decision = input.decision;
  let outcome: AuditOutcome | null = null;
  if (decision.tier === 1 && decision.sensitive_read) {
    outcome = 'logged';
  } else if (decision.tier === 3 && decision.auto_deny !== null) {
    outcome = 'auto_denied';
  }
  if (outcome === null) {
    return;
  }
  await writer.record({
    tenant_id: input.identity.tenant_id,
    created_by: input.identity.created_by,
    conversation_id: input.identity.conversation_id,
    tier: decision.tier,
    tool_name: input.tool_name,
    description: decision.reason_detail ?? input.tool_name,
    outcome,
    auto_deny_reason: decision.auto_deny,
  });
}
