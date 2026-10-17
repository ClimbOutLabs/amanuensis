/**
 * Sentinel three-tier permission model: types shared by the classifier, the
 * dispatch integration, and the approval card payload. Tier is always computed
 * server-side; the UI renders the propagated value and never re-derives it.
 */
import { z } from '@hono/zod-openapi';

import type { ShellApprovalBinding } from './approvalTokens';

/** Sentinel permission tier: 1 silent, 2 asks unless the user relaxed its kind, 3 always asks. */
export type Tier = 1 | 2 | 3;

export const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('Sentinel permission tier.');

/**
 * Tier 3 reason codes for calls the classifier ranks as a send, destructive, install or hint-escalated
 * action. A durable approval is argument-blind, so these never get chat or always scope, whatever the
 * hosting server declares about the tool.
 */
export const GRANT_BARRED_TIER_REASONS: ReadonlySet<string> = new Set([
  'external_service',
  'destructive_action',
  'install_action',
  'mcp_destructive_hint',
  'mcp_open_world_hint',
  'connector_outbound',
]);

/** Tier 2 action kinds the user may relax to run without asking. Pinned to the Tier 2 member list. */
export const TIER2_ACTION_KINDS = ['file_write'] as const;
export type Tier2ActionKind = (typeof TIER2_ACTION_KINDS)[number];

/** Machine-readable reasons a Tier 3 action is auto-denied without a card. */
export const AUTO_DENY_REASONS = [
  'destination_unverifiable',
  'incomplete_send_card',
  'offline_mode',
  'outbound_guard',
] as const;
export type AutoDenyReason = (typeof AUTO_DENY_REASONS)[number];

/**
 * Server-rendered approval card for Tier 3 actions and for Tier 2 actions that ask. Destination/recipient/amount come from
 * the server-side extractor registry over canonical params, never agent text.
 * Shell cards carry the server-parsed command instead of a destination.
 */
export const Tier3CardSchema = z
  .object({
    plain_what: z.string().describe('One plain-language sentence describing what will happen. No jargon.'),
    plain_why: z
      .string()
      .nullable()
      .describe('One sentence on why the agent wants this, from agent intent when available.'),
    cannot_be_undone: z.string().nullable().describe("A short note on what can't be reversed, or null."),
    why_asked_again: z.string().nullable().describe('Actual cause of re-escalation, or null on first ask.'),
    destination: z.string().nullable().describe('Verifiable destination (URL, service name), or null.'),
    recipient: z.string().nullable().describe('Verifiable recipient (address, handle), or null.'),
    amount: z.string().nullable().describe('Verifiable amount, or null.'),
    parsed_command: z.string().nullable().describe('Server-parsed command structure for shell actions, or null.'),
    outbound_text: z
      .string()
      .nullable()
      .describe('Exact arguments sent to a connector, one "name: value" line each. Long values are cut with a marker.'),
    destination_host: z
      .string()
      .nullable()
      .describe('Host of the connector server that receives the call, or null when it is not a remote server.'),
    outbound_truncated: z.boolean().describe('True when part of outbound_text is cut and not shown in full.'),
  })
  .openapi('Tier3Card');

export type Tier3Card = z.infer<typeof Tier3CardSchema>;

/** Machine-readable classifier verdict attached to every classified action. */
export interface TierDecision {
  tier: Tier;
  /** Stable reason code, e.g. 'allowlist_shell', 'tracked_executable', 'unclassified_tool'. */
  reason: string;
  /** Human-readable detail for logs and the audit feed. */
  reason_detail: string | null;
  /** Tier 1 read of a sensitive path: allowed but flagged for the audit feed. */
  sensitive_read: boolean;
  /** True when MCP hints escalated the tier. */
  escalated: boolean;
  /** Set when the action is auto-denied without a card. */
  auto_deny: AutoDenyReason | null;
  /** Populated for Tier 3 carded actions and for every Tier 2 action. */
  card: Tier3Card | null;
  /** Tier 2 member kind, for the per-kind relaxation lookup. */
  tier2_kind: Tier2ActionKind | null;
  /**
   * Content/argv binding captured at classify time for tracked-file executions.
   * The pre-invocation check re-verifies these byte-for-byte; used to record the
   * approval grant after a successful allow decision.
   */
  approval_binding: TrackedExecutionBinding | null;
  /** Single-use approval token id minted for actions that need approval, or null (Tier 1, relaxed Tier 2). */
  approval_token_id: string | null;
  /** Text of a web search that runs without asking, for the chat chip and the audit row; null otherwise. */
  silent_search_query: string | null;
  /**
   * Full parsed shell binding for shell actions that need approval (or null).
   * Re-verified byte-for-byte immediately before invocation.
   */
  shell_binding: ShellApprovalBinding | null;
}

/** Hash binding for a tracked executable file execution. */
export interface TrackedExecutionBinding {
  file_identity: string;
  content_hash: string;
  argv_hash: string;
}

export const TrackedExecutionBindingSchema = z
  .object({
    file_identity: z.string(),
    content_hash: z.string(),
    argv_hash: z.string(),
  })
  .describe('Host-only content/argv binding for tracked-executable approvals.');

/** Sentinel verdict for actions the classifier cannot categorize: Tier 3, fail closed. */
export function failClosedDecision(input: { reason_detail: string | null }): TierDecision {
  return {
    tier: 3,
    reason: 'unclassified',
    reason_detail: input.reason_detail,
    sensitive_read: false,
    escalated: false,
    auto_deny: null,
    card: null,
    tier2_kind: null,
    approval_binding: null,
    approval_token_id: null,
    silent_search_query: null,
    shell_binding: null,
  };
}

function baseDecision(): Omit<TierDecision, 'tier' | 'reason' | 'reason_detail'> {
  return {
    sensitive_read: false,
    escalated: false,
    auto_deny: null,
    card: null,
    tier2_kind: null,
    approval_binding: null,
    approval_token_id: null,
    silent_search_query: null,
    shell_binding: null,
  };
}

/** Tier 1: silent, no card, no notice. */
export function tier1Decision(input: {
  reason: string;
  reason_detail: string | null;
  sensitive_read: boolean;
  silent_search_query?: string | null | undefined;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 1,
    reason: input.reason,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    silent_search_query: input.silent_search_query ?? null,
  };
}

/**
 * Tier 2: workspace-contained action. Without an approval token the kind is
 * relaxed and the action runs; with one the action waits for approval.
 */
export function tier2Decision(input: {
  kind: Tier2ActionKind;
  card: Tier3Card;
  reason: string;
  reason_detail: string | null;
  sensitive_read: boolean;
  approval_token_id?: string | null | undefined;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 2,
    reason: input.reason,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    card: input.card,
    tier2_kind: input.kind,
    approval_token_id: input.approval_token_id ?? null,
  };
}

/** Tier 3: approval card shown; the action is blocked until the user approves. */
export function tier3Decision(input: {
  card: Tier3Card;
  reason: string;
  reason_detail: string | null;
  sensitive_read: boolean;
  escalated?: boolean | undefined;
  tier2_kind?: Tier2ActionKind | null | undefined;
  approval_binding?: TrackedExecutionBinding | null | undefined;
  approval_token_id?: string | null | undefined;
  shell_binding?: ShellApprovalBinding | null | undefined;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 3,
    reason: input.reason,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    escalated: input.escalated ?? false,
    card: input.card,
    tier2_kind: input.tier2_kind ?? null,
    approval_binding: input.approval_binding ?? null,
    approval_token_id: input.approval_token_id ?? null,
    shell_binding: input.shell_binding ?? null,
  };
}

/** Tier 3 auto-denied without a card. */
export function autoDenyDecision(input: {
  reason: AutoDenyReason;
  reason_detail: string | null;
  sensitive_read: boolean;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 3,
    reason: 'auto_denied',
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    auto_deny: input.reason,
  };
}
