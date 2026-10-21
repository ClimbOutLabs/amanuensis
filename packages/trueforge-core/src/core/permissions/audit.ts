/**
 * Sentinel audit log writer contract. The durable append-only store lives in
 * the server package; this interface lets trueforge-core record entries
 * without importing server code. Classify-time entries are written before
 * the action executes; outcomes of approved or relaxed actions are written
 * after dispatch. Retention is bounded server-side (default 90 days).
 */
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import type { SentinelCallIdentity, SentinelServices } from './context';
import { MAPS_SILENT_REASON } from './mapsToolNames';
import {
  HOLD_SAY,
  isSearchHoldCardText,
  savedSearchHold,
  SEARCH_SERVER_FALLBACK,
  searchHoldAuditText,
} from './searchHoldText';
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
  if (decision.tier === 1 && (decision.sensitive_read || decision.reason === MAPS_SILENT_REASON)) {
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

/**
 * Record a call that ran without asking on standing trust: a first-party connector, or the user's
 * own tool grant. Written once, right before dispatch, because the same call is classified several
 * times on its way there.
 */
export async function recordStandingTrustRun(input: {
  services: SentinelServices;
  identity: Pick<SentinelCallIdentity, 'tenant_id' | 'created_by' | 'conversation_id'>;
  tool_name: string;
  description: string;
}): Promise<void> {
  const writer = input.services.audit;
  if (writer === null) {
    return;
  }
  await writer.record({
    tenant_id: input.identity.tenant_id,
    created_by: input.identity.created_by,
    conversation_id: input.identity.conversation_id,
    tier: 1,
    tool_name: input.tool_name,
    description: input.description,
    outcome: 'logged',
    auto_deny_reason: null,
  });
}

/**
 * Audit row text for a call that asked. Any search provider call, or a card shaped like a held
 * search, is described without its query, including calls stored before audit_description existed.
 */
export function heldCallAuditText(
  info: Pick<InternalToolCallInfo, 'original_tool_name' | 'audit_description' | 'search_provider_call' | 'tier3_card'>,
): string {
  if (info.audit_description !== undefined) {
    return info.audit_description;
  }
  const card = info.tier3_card ?? null;
  if (info.search_provider_call === true || (card !== null && isSearchHoldCardText(card.plain_what))) {
    return searchHoldAuditText({
      server: card?.destination ?? SEARCH_SERVER_FALLBACK,
      say: savedSearchHold(card?.why_asked_again ?? null)?.say ?? HOLD_SAY.generic,
    });
  }
  return card?.plain_what ?? info.original_tool_name;
}

/**
 * Record what became of an action an unattended run held: held ('logged'), then refused or turned
 * down ('denied'), or approved without a later dispatch row ('approved'). An approval that still asks
 * is recorded after dispatch like any other.
 */
export async function recordHeldActionAudit(input: {
  services: SentinelServices;
  identity: Pick<SentinelCallIdentity, 'tenant_id' | 'created_by' | 'conversation_id'>;
  info: InternalToolCallInfo;
  outcome: Extract<AuditOutcome, 'logged' | 'approved' | 'denied'>;
  /** What happened, in plain words, written before the action's own description. */
  note: string;
}): Promise<void> {
  const writer = input.services.audit;
  if (writer === null) {
    return;
  }
  await writer.record({
    tenant_id: input.identity.tenant_id,
    created_by: input.identity.created_by,
    conversation_id: input.identity.conversation_id,
    tier: input.info.tier ?? 3,
    tool_name: input.info.original_tool_name,
    description: `${input.note}: ${heldCallAuditText(input.info)}`,
    outcome: input.outcome,
    auto_deny_reason: null,
  });
}
