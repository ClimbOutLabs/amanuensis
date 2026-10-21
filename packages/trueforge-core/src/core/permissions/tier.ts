/**
 * Sentinel three-tier permission model: types shared by the classifier, the
 * dispatch integration, and the approval card payload. Tier is always computed
 * server-side; the UI renders the propagated value and never re-derives it.
 */
import { z } from '@hono/zod-openapi';

import type { ShellApprovalBinding } from './approvalTokens.js';
import { Tier3MailboxSchema } from './tierMailbox';

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
  'connector_send',
  'calendar_write',
  'schedule_write',
  'persona_write',
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
  'private_text_check',
  'unattended_run',
] as const;
export type AutoDenyReason = (typeof AUTO_DENY_REASONS)[number];

export const Tier3EmailSchema = z
  .object({
    action: z
      .enum(['send', 'save', 'change'])
      .describe('What happens to the message: sent, saved as a draft, or a saved draft changed.'),
    to: z.array(Tier3MailboxSchema).describe('Recipients.'),
    cc: z.array(Tier3MailboxSchema).describe('Copied recipients.'),
    bcc: z.array(Tier3MailboxSchema).describe('Hidden copy recipients.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('The whole message text, exactly as it will be sent.'),
    replaces: z
      .object({
        subject: z.string().describe('Subject of the draft being replaced.'),
        to: z.array(Tier3MailboxSchema).describe('Recipients of the draft being replaced.'),
      })
      .nullable()
      .describe('The saved draft a change replaces, or null.'),
    reply_in_thread: z
      .object({
        subject: z.string().describe('Subject of the message being answered.'),
        from: z.string().describe('Sender of the message being answered.'),
      })
      .nullable()
      .describe('The message a reply answers in its thread, or null when the message is not a reply.'),
  })
  .describe('The message an email action sends or saves, shown in full.')
  .openapi('Tier3Email');

const Tier3CalendarEventBeforeSchema = z
  .object({
    title: z.string().describe('Title before the change.'),
    when: z.string().describe('Local date and time before the change, in plain words.'),
    duration: z.string().describe('How long the event lasted before the change.'),
    location: z.string().describe('Place before the change; empty when none.'),
  })
  .describe('The event as it is now, before a change.')
  .openapi('Tier3CalendarEventBefore');

export const Tier3CalendarEventSchema = z
  .object({
    action: z.enum(['create', 'change']).describe('Whether a new event is added or an existing one changed.'),
    calendar: z.string().describe('The Google account whose main calendar is written.'),
    title: z.string().describe('Event title.'),
    when: z.string().describe('Local date and time in plain words.'),
    time_zone: z.string().describe('IANA time zone the times are in.'),
    duration: z.string().describe('How long the event lasts, in plain words.'),
    location: z.string().describe('Place; empty when none.'),
    description: z.string().describe('Description the write sets; empty when none.'),
    attendees: z.array(z.string()).describe('Every guest on the event.'),
    guests_emailed: z.boolean().describe('True when Google emails the guests about this.'),
    one_of_repeating: z.boolean().describe('True when this changes one date of a repeating event.'),
    before: Tier3CalendarEventBeforeSchema.nullable(),
  })
  .describe('The calendar event a write adds or changes, shown in full.')
  .openapi('Tier3CalendarEvent');

/** A schedule that a chat call creates or deletes, shown in full. */
export const Tier3ScheduleSchema = z
  .object({
    action: z.enum(['create', 'delete']).describe('Whether the schedule is created or deleted.'),
    name: z.string().describe('Schedule name in plain words.'),
    when: z.string().describe('When it runs, in plain words.'),
    time_zone: z.string().describe('IANA time zone the times are in.'),
    task: z.string().describe('The whole instruction each run gets.'),
    runs_as: z.string().describe('Who runs it: the assistant name, or the agent name.'),
    next_runs: z
      .array(z.string())
      .describe('The next three runs in plain words for a new schedule; empty for a delete.'),
  })
  .describe('The schedule a chat call creates or deletes, shown in full.')
  .openapi('Tier3Schedule');

/** A specialist that a chat call adds, shown in full. Existing personas are never changed by a call. */
export const Tier3PersonaSchema = z
  .object({
    name: z.string().describe('Specialist name in plain words.'),
    description: z.string().describe('One line on what the specialist is for.'),
    instructions: z.string().describe('The whole instruction text the specialist follows.'),
    model_name: z.string().describe('The model the specialist answers with.'),
  })
  .describe('The specialist a chat call adds, shown in full.')
  .openapi('Tier3Persona');

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
    email: Tier3EmailSchema.nullable().optional(),
    calendar_event: Tier3CalendarEventSchema.nullable().optional(),
    schedule: Tier3ScheduleSchema.nullable().optional(),
    persona: Tier3PersonaSchema.nullable().optional(),
  })
  .openapi('Tier3Card');

export type Tier3Card = z.infer<typeof Tier3CardSchema>;
export type Tier3Schedule = z.infer<typeof Tier3ScheduleSchema>;
export type Tier3Persona = z.infer<typeof Tier3PersonaSchema>;

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
  /** One plain line for the owner when an auto-denied call needs more than the generic message, or null. */
  owner_message: string | null;
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
  /** Audit-row text that stands in for the card sentence when that sentence quotes caught text. */
  audit_description: string | null;
  /**
   * Full parsed shell binding for shell actions that need approval (or null).
   * Re-verified byte-for-byte immediately before invocation.
   */
  shell_binding: ShellApprovalBinding | null;
  /**
   * True for a connector read that may be granted "Always allow" like an annotated read-only tool. The call
   * is stamped as inspection, so the grant and chat scope both apply to it.
   */
  inspection: boolean;
  /** Host of the connector the call goes to; a standing grant the user records on this ask binds to it. */
  grant_host: string | null;
  /** True for a private read: a sensitive path, or an argument with a path shape. Never eligible for a standing grant or chat scope. */
  secret_path_read: boolean;
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
    owner_message: null,
    card: null,
    tier2_kind: null,
    approval_binding: null,
    approval_token_id: null,
    silent_search_query: null,
    audit_description: null,
    shell_binding: null,
    inspection: false,
    grant_host: null,
    secret_path_read: false,
  };
}

function baseDecision(): Omit<TierDecision, 'tier' | 'reason' | 'reason_detail'> {
  return {
    sensitive_read: false,
    escalated: false,
    auto_deny: null,
    owner_message: null,
    card: null,
    tier2_kind: null,
    approval_binding: null,
    approval_token_id: null,
    silent_search_query: null,
    audit_description: null,
    shell_binding: null,
    inspection: false,
    grant_host: null,
    secret_path_read: false,
  };
}

/** Tier 1: silent, no card, no notice. */
export function tier1Decision(input: {
  reason: string;
  reason_detail: string | null;
  sensitive_read: boolean;
  silent_search_query?: string | null | undefined;
  inspection?: boolean | undefined;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 1,
    reason: input.reason,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    silent_search_query: input.silent_search_query ?? null,
    inspection: input.inspection === true,
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
  inspection?: boolean | undefined;
  grant_host?: string | null | undefined;
  secret_path_read?: boolean | undefined;
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
    inspection: input.inspection === true,
    grant_host: input.grant_host ?? null,
    secret_path_read: input.secret_path_read === true,
  };
}

/** Tier 3 auto-denied without a card. */
export function autoDenyDecision(input: {
  reason: AutoDenyReason;
  reason_detail: string | null;
  owner_message?: string | null | undefined;
  sensitive_read: boolean;
}): TierDecision {
  return {
    ...baseDecision(),
    tier: 3,
    reason: 'auto_denied',
    owner_message: input.owner_message ?? null,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
    auto_deny: input.reason,
  };
}
