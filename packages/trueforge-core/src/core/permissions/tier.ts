/**
 * Sentinel three-tier permission model: types shared by the classifier, the
 * dispatch integration, and the approval card payload. Tier is always computed
 * server-side; the UI renders the propagated value and never re-derives it.
 */
import { z } from '@hono/zod-openapi';

import { APPROVAL_EXPIRED_REASON_CODE } from './approvalExpiry';
import type { ShellApprovalBinding } from './approvalTokens.js';
import { Tier3MailboxSchema } from './tierMailbox';

/** Sentinel permission tier: 1 silent, 2 asks unless the user relaxed its kind, 3 always asks. */
export type Tier = 1 | 2 | 3;

export const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('Sentinel permission tier.');

/** Tier 1 reason codes for a command run in the sandbox without a card. Each one is written to the activity list. */
export const SANDBOX_COMMAND_REASON = 'sandbox_command';
export const SANDBOX_FILE_WRITE_REASON = 'sandbox_file_write';
export const SANDBOX_RUN_CODE_REASON = 'sandbox_run_code';
export const SANDBOX_SILENT_REASONS: ReadonlySet<string> = new Set([
  SANDBOX_COMMAND_REASON,
  SANDBOX_FILE_WRITE_REASON,
  SANDBOX_RUN_CODE_REASON,
]);

/** Tier 3 reason codes for cancelling a reminder and for pausing or resuming a schedule. Each asks every time. */
export const REMINDER_CANCEL_REASON = 'reminder_cancel';
export const SCHEDULE_STATUS_REASON = 'schedule_status';

/** Reason code for a consequential action whose recipient or site only content the assistant read named. */
export const CONTENT_STEERED_REASON = 'content_steered';

/**
 * A connector read that would run without a card, stopped because of what its arguments carry. It asks each
 * time: an answer that covered later reads would cover whatever they carry.
 */
export const CONNECTOR_READ_GUARD_REASON = 'connector_read_guard';

/** Tier 2 action kinds the user may relax to run without asking. Pinned to the Tier 2 member list. */
export const TIER2_ACTION_KINDS = ['file_write'] as const;
export type Tier2ActionKind = (typeof TIER2_ACTION_KINDS)[number];

/** Machine-readable reasons a Tier 3 action is auto-denied: without a card, or after its card went unanswered. */
export const AUTO_DENY_REASONS = [
  APPROVAL_EXPIRED_REASON_CODE,
  'cannot_describe',
  'destination_unverifiable',
  'incognito_chat',
  'incomplete_send_card',
  'lookup_limit',
  'offline_mode',
  'outbound_guard',
  'private_detail',
  'steered_by_content',
  'tool_not_prepared',
  'unattended_run',
  'home_assistant_refused',
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
    // Cards stored before this field existed carry no code.
    check_code: z
      .string()
      .nullable()
      .default(null)
      .describe('Short code for a send, repeated on its receipt; null for a draft.'),
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
    // Cards stored before this field existed read as replies going to the sender, as they did then.
    reply_to: z
      .string()
      .nullable()
      .default(null)
      .describe('The address replies go to when it is not the sender, or null when replies go to the sender.'),
    // Absent on cards stored before these fields existed: a reader must treat absent as not known.
    from_name: z
      .string()
      .nullable()
      .optional()
      .describe('The display name the message is sent as, or null when none is set.'),
    name_left_off: z
      .boolean()
      .optional()
      .describe('True when a name was left off an address because it looked like an address.'),
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
    // Absent on cards stored before these fields existed: a reader must treat absent as not known.
    already_created: z
      .boolean()
      .optional()
      .describe('True when the same event was already created in this chat a few minutes ago.'),
    span_days: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('How many days the event runs over; 1 for an ordinary event.'),
  })
  .describe('The calendar event a write adds or changes, shown in full.')
  .openapi('Tier3CalendarEvent');

/** One connector or skill a new schedule may run with, and whether it is turned on. */
export const Tier3ScheduleToolChoiceSchema = z
  .object({
    name: z.string().describe('Connector or skill name.'),
    on: z.boolean().describe('True when the schedule runs with it.'),
  })
  .openapi('Tier3ScheduleToolChoice');

/** What a new schedule runs with, as it will be saved. */
export const Tier3ScheduleToolsSchema = z
  .object({
    editable: z.boolean().describe('True when the person may ask for other choices before approving.'),
    agent_name: z.string().describe('The agent the schedule runs as.'),
    connectors: z.array(Tier3ScheduleToolChoiceSchema).describe('Connectors the person may pick from.'),
    skills: z.array(Tier3ScheduleToolChoiceSchema).describe('Skills the person may pick from.'),
    run_code: z.boolean().describe('True when runs may run code.'),
    memory: z.boolean().describe('True when runs recall memories.'),
  })
  .openapi('Tier3ScheduleTools');

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
    tools: Tier3ScheduleToolsSchema.nullable()
      .optional()
      .describe('What a new schedule runs with; absent for a delete and on an older card.'),
  })
  .describe('The schedule a chat call creates or deletes, shown in full.')
  .openapi('Tier3Schedule');

/** A persona that a chat call adds, shown in full. Existing personas are never changed by a call. */
export const Tier3PersonaSchema = z
  .object({
    name: z.string().describe('Persona name in plain words.'),
    description: z.string().describe('One line on what the persona is for.'),
    instructions: z.string().describe('The whole instruction text the persona follows.'),
    model_name: z.string().describe('The model the persona answers with.'),
  })
  .describe('The persona a chat call adds, shown in full.')
  .openapi('Tier3Persona');

/** Why a skill network card is asked: the skill's first use, or a site it reached for without declaring. */
export const Tier3SkillNetworkReasonSchema = z
  .enum(['first_use', 'undeclared_host'])
  .describe('Why the card is asked: the skill\u2019s first use, or a site it did not declare.')
  .openapi('Tier3SkillNetworkReason');

/**
 * The network question a skill network card asks, shown in full: the skill, the sites, and why.
 * `code_pin` names the exact code the approval covers once code pinning lands; until then null.
 */
export const Tier3SkillNetworkSchema = z
  .object({
    skill_name: z.string().describe('Name of the skill asking for network access.'),
    hosts: z.array(z.string()).describe('The sites the skill asks to reach.'),
    reason: Tier3SkillNetworkReasonSchema,
    code_pin: z
      .string()
      .nullable()
      .describe('The code version the approval is pinned to, or null when no pin is in force.'),
  })
  .describe('The skill network access a card asks about, shown in full.')
  .openapi('Tier3SkillNetwork');

/** A skill that a chat call adds, as the host read it from where it comes from. */
export const Tier3SkillSchema = z
  .object({
    name: z.string().describe('Skill name.'),
    description: z.string().describe('What the skill is for, as the skill itself says.'),
    source: z.string().describe('The repository the skill comes from, and the folder in it when there is one.'),
    version: z.string().describe('The exact commit that is added. A later change to the repository is not picked up.'),
    starter: z.boolean().describe('True when this is one of the starter skills that come with the app.'),
    instructions: z
      .string()
      .nullable()
      .describe("The skill's own instruction file as the host read it, or null for a starter skill."),
  })
  .describe('The skill a chat call adds, shown in full.')
  .openapi('Tier3Skill');

/**
 * The words an approval card is made of, produced in trueforge-core by one owner per action kind
 * (see cardCopy.ts). The UI renders these three parts and never builds sentences of its own: one
 * headline, one consequence line when it matters, and the tier reason on its own line.
 * None of the three ever carries an internal id: things are named the way the person names them.
 */
export const ApprovalCardCopySchema = z
  .object({
    headline: z.string().describe('What will happen, in one sentence, in words the person recognises.'),
    consequence: z
      .string()
      .nullable()
      .describe('What follows from approving, in one line, or null when nothing needs saying.'),
    reason: z.string().nullable().describe('Why the tier asks, in plain words, or null when it needs no reason.'),
  })
  .describe('The headline, consequence and reason an approval card shows.')
  .openapi('ApprovalCardCopy');

export type ApprovalCardCopy = z.infer<typeof ApprovalCardCopySchema>;

/**
 * Server-rendered approval card for Tier 3 actions and for Tier 2 actions that ask. Destination/recipient/amount come from
 * the server-side extractor registry over canonical params, never agent text.
 * Shell cards carry the server-parsed command instead of a destination.
 */
export const Tier3CardSchema = z
  .object({
    plain_what: z.string().describe('One plain-language sentence describing what will happen. No jargon.'),
    copy: ApprovalCardCopySchema.nullable().describe(
      'The headline, consequence and reason the card renders. Every builder fills it from its copy owner; null only where a later choke point fills it, never on a finished card.',
    ),
    safe_choice: z
      .boolean()
      .optional()
      .describe(
        "True when the action is irreversible or reaches other people, so the no choice uses safe words such as Keep it or Don't send.",
      ),
    destructive: z
      .boolean()
      .optional()
      .describe('True when the action destroys or sends something for good, so the no choice says Keep it.'),
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
    outbound_plumbing_text: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Lines of outbound_text that a search service adds on its own, repeated so the card can fold them. Null when none.',
      ),
    email: Tier3EmailSchema.nullable().optional(),
    calendar_event: Tier3CalendarEventSchema.nullable().optional(),
    schedule: Tier3ScheduleSchema.nullable().optional(),
    persona: Tier3PersonaSchema.nullable().optional(),
    skill: Tier3SkillSchema.nullable().optional(),
    mail_new_recipients: z
      .array(z.string())
      .nullable()
      .optional()
      .describe('For a mail send to addresses not yet on the Email list: those addresses, lowercased. Otherwise null.'),
    mail_draft: z
      .boolean()
      .optional()
      .describe('True when a card carrying mail_new_recipients approves saving a draft rather than sending.'),
    skill_network: Tier3SkillNetworkSchema.nullable()
      .optional()
      .describe('For a skill network card: the skill, the sites it asks for, and why. Otherwise null.'),
  })
  .openapi('Tier3Card');

export type Tier3Card = z.infer<typeof Tier3CardSchema>;
export type Tier3Email = z.infer<typeof Tier3EmailSchema>;
export type Tier3SkillNetwork = z.infer<typeof Tier3SkillNetworkSchema>;
export type Tier3Schedule = z.infer<typeof Tier3ScheduleSchema>;
export type Tier3ScheduleTools = z.infer<typeof Tier3ScheduleToolsSchema>;
export type Tier3Persona = z.infer<typeof Tier3PersonaSchema>;
export type Tier3Skill = z.infer<typeof Tier3SkillSchema>;

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
  /** The connector setup the call goes to (see `ToolGrantKey`); a standing grant the user records on this ask binds to it. */
  grant_binding: string | null;
  /**
   * Tool name a standing grant for this call is recorded under, when the grant covers a scope
   * wider than the one tool (a Home Assistant domain, say). Null records under the tool's own name.
   */
  grant_tool_name: string | null;
  /** True for a private read: a sensitive path, or an argument with a path shape. Never eligible for a standing grant or chat scope. */
  secret_path_read: boolean;
  /** True for a send through the host's own Email sidecar. Steering changes the reason, never this, so the send-list step still runs. */
  mail_send: boolean;
  /** True when the classifying branch bars this call from a standing grant across chats. */
  standing_grant_barred: boolean;
  /** True when this consequential call may take a chat grant for the target its card names. */
  chat_grantable_consequence: boolean;
  /** True when this call changes only the person's own calendar, with no guest reached. */
  own_calendar_change: boolean;
  /** True when this call writes only the person's own Drive files and sends nothing to anyone. */
  own_drive_write: boolean;
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
    grant_binding: null,
    grant_tool_name: null,
    secret_path_read: false,
    mail_send: false,
    standing_grant_barred: false,
    chat_grantable_consequence: false,
    own_calendar_change: false,
    own_drive_write: false,
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
    grant_binding: null,
    grant_tool_name: null,
    secret_path_read: false,
    mail_send: false,
    standing_grant_barred: false,
    chat_grantable_consequence: false,
    own_calendar_change: false,
    own_drive_write: false,
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
  grant_binding?: string | null | undefined;
  grant_tool_name?: string | null | undefined;
  secret_path_read?: boolean | undefined;
  mail_send?: boolean | undefined;
  standing_grant_barred?: boolean | undefined;
  chat_grantable_consequence?: boolean | undefined;
  own_calendar_change?: boolean | undefined;
  own_drive_write?: boolean | undefined;
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
    grant_binding: input.grant_binding ?? null,
    grant_tool_name: input.grant_tool_name ?? null,
    secret_path_read: input.secret_path_read === true,
    mail_send: input.mail_send === true,
    standing_grant_barred: input.standing_grant_barred === true,
    chat_grantable_consequence: input.chat_grantable_consequence === true,
    own_calendar_change: input.own_calendar_change === true,
    own_drive_write: input.own_drive_write === true,
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
