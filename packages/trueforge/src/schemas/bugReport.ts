/**
 * Wire schemas for the redacted per-session bug-report bundle
 * (`POST /api/v1/sessions/{session_id}/bug-report`).
 *
 * Every field here is an allowlisted, structure-only projection of the session's events —
 * see `apis/bugReportRedactor.ts` for the assembly and redaction logic. Message text, memory
 * recall content, learned-profile text, and tool-call arguments/results never reach this shape;
 * only counts, names, outcomes, and durations do.
 */
import { z } from '@hono/zod-openapi';
import { ToolOutputTransformSchema } from '@truefoundry/trueforge-core/core';
import { BuildIdentitySchema } from './capability';

/** Bundle format; bump when the shape of `BugReportBundle` changes incompatibly. */
export const BUG_REPORT_SCHEMA_VERSION = 1;

export const BugReportSessionSchema = z
  .object({
    id: z.string().describe('Session id the bundle was generated for.'),
    agent_name: z.string().nullable().describe('Named registry agent bound to the session, or null when inline.'),
    model: z
      .string()
      .nullable()
      .describe('Model FQN in effect for the session, or null when it could not be resolved.'),
    created_at: z.string().describe('ISO 8601 session creation timestamp.'),
    connectors: z.array(z.string()).describe('Names of the connectors attached to the session agent.'),
    skills: z.array(z.string()).describe('Names of the skills attached to the session agent.'),
    sandbox_enabled: z.boolean().describe('Whether the session agent has a sandbox.'),
  })
  .openapi('BugReportSession');

/**
 * The bounded error carried by a single structural trace event. `code` is a machine-readable,
 * host-owned reason code (e.g. a tool `reason_code`, a memory-recall outcome); `message` is a
 * fixed host-authored diagnostic derived from that code — never the raw, free-text error or
 * remediation string from the source event (see `apis/bugReportRedactor.ts`).
 */
export const BugReportTraceEventErrorSchema = z
  .object({
    code: z.string().nullable().describe('Machine-readable reason code, or null when none was recorded.'),
    message: z.string().describe('Host-generated diagnostic message.'),
  })
  .openapi('BugReportTraceEventError');

/**
 * One structural fact from the session's event log: an event `type` plus only the
 * allowlisted, non-content fields relevant to that type. Every field is optional because a
 * single flat shape covers every event kind — a given event populates only the fields that
 * apply to it (e.g. `role`/`char_count` for a message, `tool_name`/`effect`/`outcome` for a
 * tool call).
 */
export const BugReportTraceEventSchema = z
  .object({
    type: z.string().describe('Event type, e.g. `model.message`, `tool.response.v2`, `aman.memory.recall`.'),
    role: z.string().optional().describe('Message role, present only for message-shaped events.'),
    char_count: z.number().int().nonnegative().optional().describe('Character count of the stripped message text.'),
    tool_name: z.string().optional().describe('Model-visible tool name, present only for tool-call events.'),
    effect: z
      .string()
      .optional()
      .describe('Server-classified tool effect (inspect/edit/verify/commit/push/execute), when known.'),
    outcome: z
      .string()
      .optional()
      .describe('Terminal disposition for a tool call, or a coarse outcome for a lifecycle/memory event.'),
    mode: z
      .enum(['coding', 'conversation'])
      .optional()
      .describe('Session mode a context-compaction event ran in; present only on `agent.context.compaction`.'),
    budget_reason: z
      .enum(['normal', 'post_compaction'])
      .optional()
      .describe('Why a memory-recall event’s token budget was what it was; present only on `aman.memory.recall`.'),
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Wall-clock duration, when both endpoints are known.'),
    error: BugReportTraceEventErrorSchema.optional().describe(
      'Present only when this event carries a structural error or remediation.',
    ),
    at_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Milliseconds since the turn started, when both timestamps are known.'),
    tool_names: z
      .array(z.string())
      .optional()
      .describe('Tools a model message asked for, in order; present only on model messages with tool calls.'),
    finish_reason: z.string().optional().describe('Provider finish reason of a model message, when recorded.'),
    exit_code: z
      .number()
      .int()
      .optional()
      .describe('Process exit code of a sandbox command, when the tool result carried one.'),
    intent: z
      .string()
      .optional()
      .describe("The model's one-line intent for a tool call. Present only when the request set `include_chat`."),
    output_transform: ToolOutputTransformSchema.optional(),
    counts: z
      .record(z.string(), z.number().int().nonnegative())
      .optional()
      .describe('Named counts for a countable event (e.g. memory recall items/entities), never the recalled content.'),
    sweep_unreachable: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of retain checks that were unreachable during the sweep.'),
    sweep_unreachable_code: z
      .string()
      .optional()
      .describe('Failure code from the last unreachable retain check, present only on aman.memory.recall.'),
  })
  .openapi('BugReportTraceEvent');

export const BugReportTurnTraceSchema = z
  .object({
    turn_id: z.string().describe('Turn that emitted these events.'),
    events: z.array(BugReportTraceEventSchema).describe('Structural events for this turn, oldest first.'),
  })
  .openapi('BugReportTurnTrace');

export const BugReportErrorSchema = z
  .object({
    turn_id: z.string().describe('Turn the error occurred in.'),
    event_type: z.string().describe('Event type that carried the error.'),
    code: z.string().nullable().describe('Machine-readable reason code, or null when none was recorded.'),
    message: z.string().describe('Host-generated diagnostic message.'),
  })
  .openapi('BugReportError');

export const BugReportConfigFlagsSchema = z
  .object({
    sandbox_enabled: z.boolean().describe('Same value as `GET /api/v1/capabilities` → `sandbox.enabled`.'),
    skill_enabled: z.boolean().describe('Same value as `GET /api/v1/capabilities` → `skill.enabled`.'),
    settings_enabled: z.boolean().describe('Same value as `GET /api/v1/capabilities` → `settings.enabled`.'),
  })
  .openapi('BugReportConfigFlags');

export const BugReportRedactionSchema = z
  .object({
    stripped_fields: z
      .array(z.string())
      .describe('Dot-path field names that were stripped from the source events before assembly.'),
    notes: z.string().describe('Human-readable summary of the redaction policy applied to this bundle.'),
  })
  .openapi('BugReportRedaction');

/** One message of the chat transcript, present only when the reporter opted in. */
export const BugReportChatMessageSchema = z
  .object({
    turn_id: z.string().describe('Turn the message belongs to.'),
    role: z.enum(['user', 'assistant']).describe('Who wrote it.'),
    text: z.string().describe('The message text, verbatim unless `truncated`.'),
    truncated: z.boolean().optional().describe('Present and true when the text was cut to the per-message limit.'),
  })
  .openapi('BugReportChatMessage');

export const BugReportChatSchema = z
  .object({
    messages: z.array(BugReportChatMessageSchema).describe('User and assistant messages, oldest first.'),
    notes: z.string().describe('What this section carries and what it still leaves out.'),
    omitted_messages: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Present when the transcript hit its total size limit: how many of the oldest messages were left out.'),
  })
  .describe('The chat transcript, present only when the request set `include_chat`. Off by default.')
  .openapi('BugReportChat');

export const BugReportBundleSchema = z
  .object({
    schema_version: z.number().int().positive().describe('Bundle format version.'),
    generated_at: z.string().describe('ISO 8601 timestamp when this bundle was assembled.'),
    build: BuildIdentitySchema,
    session: BugReportSessionSchema,
    user_description: z.string().describe("The reporter's typed description, verbatim."),
    summary: z
      .array(z.string())
      .describe('Host-written plain-language lines, one per turn, saying what happened and how it ended.'),
    trace: z.array(BugReportTurnTraceSchema).describe('Per-turn structural event trace, oldest turn first.'),
    recent_errors: z.array(BugReportErrorSchema).describe('Errors surfaced across the trace, newest first.'),
    config_flags: BugReportConfigFlagsSchema,
    redaction: BugReportRedactionSchema,
    chat: BugReportChatSchema.optional(),
  })
  .openapi('BugReportBundle');

export const CreateSessionBugReportRequestSchema = z
  .object({
    description: z
      .string()
      .max(8000)
      .optional()
      .describe('Optional free-text description of what went wrong; included in the bundle verbatim.'),
    include_chat: z
      .boolean()
      .optional()
      .describe(
        "When true, the bundle also carries this chat's user and assistant message text under `chat`. " +
          'Off by default; the reporter opts in per report. Tool arguments and results, memory content, and ' +
          'credentials stay out either way.',
      ),
  })
  .openapi('CreateSessionBugReportRequest');

export const CreateSessionBugReportResponseSchema = z
  .object({
    data: BugReportBundleSchema,
  })
  .openapi('CreateSessionBugReportResponse');

export type BugReportSession = z.infer<typeof BugReportSessionSchema>;
export type BugReportTraceEventError = z.infer<typeof BugReportTraceEventErrorSchema>;
export type BugReportTraceEvent = z.infer<typeof BugReportTraceEventSchema>;
export type BugReportTurnTrace = z.infer<typeof BugReportTurnTraceSchema>;
export type BugReportError = z.infer<typeof BugReportErrorSchema>;
export type BugReportConfigFlags = z.infer<typeof BugReportConfigFlagsSchema>;
export type BugReportRedaction = z.infer<typeof BugReportRedactionSchema>;
export type BugReportChatMessage = z.infer<typeof BugReportChatMessageSchema>;
export type BugReportChat = z.infer<typeof BugReportChatSchema>;
export type BugReportBundle = z.infer<typeof BugReportBundleSchema>;
export type CreateSessionBugReportRequest = z.infer<typeof CreateSessionBugReportRequestSchema>;
