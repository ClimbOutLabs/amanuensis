// Harness wire-format event schemas (OpenAPI-decorated Zod).
import { z } from '@hono/zod-openapi';
import { monotonicFactory } from 'ulid';
import { ToolOutputScreenDecisionSchema, type ToolOutputScreenDecision } from '../../schemas/toolOutputScreen';
import {
  CompletionUsageSchema,
  EnrichedAssistantMessageSchema,
  ExtendedChunkDeltaSchema,
  FinishReasonSchema,
  InternalEnrichedAssistantMessageSchema,
  LLMSystemMessageSchema,
  LLMToolMessageSchema,
  LLMUserMessageSchema,
  RegisteredCommandExecutionSchema,
} from '../llm/LLMTypes';
import { Tier3CardSchema, TierSchema } from '../permissions/tier';
import { CurrentContextUsageSchema } from '../runtime/contextUsage';

/**
 * Process-local monotonic ULIDs preserve event creation order, including
 * multiple events created in the same millisecond. A turn has one sequential
 * writer, so this is the durable event order key.
 *
 * @see https://github.com/ulid/spec#monotonicity
 */
const monotonicUlid = monotonicFactory();

export function newEventId(): string {
  return monotonicUlid().toLowerCase();
}

/** Canonical string constants for harness wire-level and user-input event `type` fields. */
export const EventType = {
  AGENT_CONTEXT_OVERWRITE: 'agent.context.overwrite',
  AGENT_CONTEXT_COMPACTION: 'agent.context.compaction',
  DOCUMENT_INGESTION: 'document.ingestion',
  MCP_AUTH_REQUIRED: 'mcp.auth_required',
  MCP_INITIALIZE: 'mcp.initialize',
  MODEL_MESSAGE: 'model.message',
  MODEL_MESSAGE_DELTA: 'model.message.delta',
  SANDBOX_CREATED: 'sandbox.created',
  THREAD_CREATED: 'thread.created',
  THREAD_DONE: 'thread.done',
  TOOL_EXECUTION_STARTED: 'tool.execution_started',
  TOOL_RESPONSE: 'tool.response',
  TOOL_RESPONSE_V2: 'tool.response.v2',
  TOOL_APPROVAL_REQUIRED: 'tool.approval_required',
  TOOL_RESPONSE_REQUIRED: 'tool.response_required',
  USER_TOOL_APPROVAL: 'user.tool_approval',
  USER_TOOL_RESPONSE: 'user.tool_response',
  USER_MESSAGE: 'user.message',
} as const;

export const EventIdSchema = z.string().openapi({
  description: 'Unique identifier for the event (monotonic ULID).',
});

export const AgentParentSchema = z
  .object({
    thread_id: z.string().describe('Parent thread that spawned the child agent.'),
    tool_call_id: z.string().describe('Tool call on the parent thread that created the child.'),
  })
  .openapi('AgentParent');

export const AgentInfoSchema = z
  .object({
    type: z.literal('dynamic').describe('Subagent kind.'),
    name: z.string().describe('Display name of the dynamic subagent.'),
    input: z.string().describe('Input prompt passed to the subagent.'),
    workspace_cwd: z
      .string()
      .min(1)
      .optional()
      .describe('Absolute local checkout path the subagent must use for delegated coding work.'),
    model: z.string().min(1).optional().describe('Optional model override for the subagent.'),
  })
  .openapi('AgentInfo');

export const AgentApprovalDecisionAllowSchema = z
  .object({
    status: z.literal('allow').describe('Allow the pending tool call(s).'),
    scope: z
      .enum(['once', 'chat', 'always'])
      .optional()
      .describe(
        'Omitted or once allows only this invocation; chat grants this exact tool for the current session; ' +
          'always allows this read-only connector tool for the caller until revoked.',
      ),
  })
  .openapi('ApprovalAllow');

export const AgentApprovalDecisionDenySchema = z
  .object({
    status: z.literal('deny').describe('Deny the pending tool call(s).'),
    reason: z.string().optional().describe('Optional reason shown to the agent when denied.'),
  })
  .openapi('ApprovalDeny');

export const ApprovalDecisionSchema = z
  .discriminatedUnion('status', [AgentApprovalDecisionAllowSchema, AgentApprovalDecisionDenySchema])
  .openapi('ApprovalDecision');

export const UserToolApprovalMessageSchema = z
  .object({
    type: z.literal(EventType.USER_TOOL_APPROVAL).describe('Client resume after tool.approval_required.'),
    thread_id: z.string().min(1, 'thread_id is required').describe('Thread that owns the pending tool call.'),
    tool_call_id: z.string().min(1, 'tool_call_id is required').describe('Tool call id being approved or denied.'),
    approval: ApprovalDecisionSchema,
  })
  .openapi('UserToolApprovalEvent');

export const UserToolResponseMessageSchema = z
  .object({
    type: z.literal(EventType.USER_TOOL_RESPONSE).describe('Client resume after tool.response_required.'),
    thread_id: z.string().min(1, 'thread_id is required').describe('Thread that owns the pending tool call.'),
    tool_call_id: z.string().min(1, 'tool_call_id is required').describe('Tool call id receiving the client response.'),
    content: z.string().min(1, 'content cannot be empty').describe('Client-side tool result content.'),
  })
  .openapi('UserToolResponseEvent');

export const TextContentPartSchema = z
  .object({
    type: z.literal('text').describe('Text content part.'),
    text: z.string().describe('Plain-text content.'),
  })
  .openapi('TextContent');
export type TextContentPart = z.infer<typeof TextContentPartSchema>;

export const FileContentPartSchema = z
  .object({
    type: z.literal('file').describe('File attachment content part.'),
    name: z.string().describe('Filename presented to the agent.'),
    data: z.string().describe('Data URI: `data:<mime>;base64,<payload>`. MIME type is parsed from the URI.'),
  })
  .openapi('FileContent');
export type FileContentPart = z.infer<typeof FileContentPartSchema>;

export const UserContentPartSchema = z
  .discriminatedUnion('type', [TextContentPartSchema, FileContentPartSchema])
  .openapi('UserMessageContentItem');
export type UserContentPart = z.infer<typeof UserContentPartSchema>;

export const AgentInputUserMessageSchema = z
  .object({
    type: z.literal(EventType.USER_MESSAGE).describe('User message input item.'),
    content: z
      .union([z.string(), z.array(UserContentPartSchema)])
      .describe('Plain string or structured text/file content parts.'),
  })
  .openapi('UserMessage');
export type AgentInputUserMessage = z.infer<typeof AgentInputUserMessageSchema>;

// persisted to redis - thread_id is stripped
/**
 * A recorded decision applies only to the call it was issued for: it names that call's approval token and
 * arguments hash, and a decision whose binding does not match the call in context is ignored. Contexts
 * saved before the binding existed parse with null and are never honoured, so they ask again.
 */
export const AgentApprovalDecisionMessageSchema = UserToolApprovalMessageSchema.omit({
  thread_id: true,
}).extend({
  approval_token_id: z.string().nullable().default(null),
  arguments_hash: z.string().nullable().default(null),
});

export const InputTokensBreakdownSchema = z.object({
  harness: z.number().int().nonnegative().describe('Tokens attributed to harness system framing.'),
  skills: z.number().int().nonnegative().describe('Tokens attributed to skill instructions.'),
  instructions: z.number().int().nonnegative().describe('Tokens attributed to agent instructions.'),
  tool_definitions: z.number().int().nonnegative().describe('Tokens attributed to tool schemas.'),
  messages: z.number().int().nonnegative().describe('Tokens attributed to conversation messages.'),
});

export const ModelMessageUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().describe('Input tokens for this model call.'),
    output_tokens: z.number().int().nonnegative().describe('Output tokens for this model call.'),
    cache_read_tokens: z.number().int().nonnegative().optional().describe('Optional cache-read tokens.'),
    cache_write_tokens: z.number().int().nonnegative().optional().describe('Optional cache-write tokens.'),
    input_tokens_breakdown: InputTokensBreakdownSchema,
  })
  .openapi('ModelMessageUsage');

export const ModelMessageEventSchema = EnrichedAssistantMessageSchema.omit({ role: true })
  .extend({
    type: z.literal(EventType.MODEL_MESSAGE).describe('Complete assistant model message.'),
    id: EventIdSchema,
    thread_id: z.string().describe('Thread that emitted this message (`main` for the root agent).'),
    finish_reason: z
      .union([FinishReasonSchema, z.null()])
      .optional()
      .describe('Model finish reason; null when the provider omitted it.'),
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    usage: ModelMessageUsageSchema.optional(),
  })
  .openapi('ModelMessageEvent');

export const ModelMessageDeltaEventSchema = ExtendedChunkDeltaSchema.omit({
  role: true,
  function_call: true,
  thinking_blocks: true,
})
  .extend({
    type: z.literal(EventType.MODEL_MESSAGE_DELTA).describe('Streaming delta for a model.message.'),
    id: EventIdSchema,
    thread_id: z.string().describe('Thread that emitted this delta.'),
    created_at: z.string().optional().describe('Optional ISO 8601 event timestamp.'),
    finish_reason: z
      .union([FinishReasonSchema, z.null()])
      .optional()
      .describe('Finish reason when this delta completes the stream.'),
    usage: ModelMessageUsageSchema.optional(),
  })
  .openapi('ModelMessageDeltaEvent');

export const ToolResponseEventSchema = LLMToolMessageSchema.omit({ role: true })
  .extend({
    type: z.literal(EventType.TOOL_RESPONSE).describe('Result of a tool execution.'),
    id: EventIdSchema,
    thread_id: z.string().describe('Thread that owns the tool call.'),
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    memoized: z.literal(true).optional().describe("The result was replayed from this turn's tool-call memo."),
    repeat_count: z.number().int().positive().optional().describe('Number of identical calls observed this turn.'),
  })
  .openapi('ToolResponseEvent');

export const ToolResultDispositionSchema = z
  .enum(['denied', 'policy_blocked', 'executed_ok', 'executed_nonzero', 'never_ran', 'outcome_unknown'])
  .openapi('ToolResultDisposition');

export const ToolResultRemediationSchema = z
  .object({
    reason_code: z.string().min(1).describe('Stable host-owned reason code.'),
    message: z.string().min(1).describe('Actionable explanation for the model and user.'),
    suggested_action: z
      .enum(['retry', 'change_strategy', 'request_approval', 'authenticate', 'inspect_state', 'contact_user'])
      .describe('Bounded next action; never an instruction inferred from tool output.'),
  })
  .openapi('ToolResultRemediation');

const AutomaticAdmissionProvenanceSchema = z.object({
  source: z.literal('automatic').describe('No interactive approval was required.'),
});
const UserApprovalAdmissionProvenanceSchema = z.object({
  source: z.literal('user_approval').describe('The user supplied this invocation decision.'),
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'chat', 'always']).optional(),
});
const ChatGrantAdmissionProvenanceSchema = z.object({
  source: z.literal('chat_grant').describe('A previously recorded exact chat grant admitted this invocation.'),
  decision: z.literal('allow'),
  scope: z.literal('chat'),
});
const ImplementationPlanGrantAdmissionProvenanceSchema = z.object({
  source: z
    .literal('implementation_plan_grant')
    .describe('A matching approved implementation plan admitted this invocation.'),
  grant_id: z.string().min(1),
});
const InternalAdmissionProvenanceSchema = z.object({
  source: z.literal('internal').describe('The host produced this result without a model-visible external dispatch.'),
});

export const ToolAdmissionProvenanceSchema = z
  .discriminatedUnion('source', [
    AutomaticAdmissionProvenanceSchema,
    UserApprovalAdmissionProvenanceSchema,
    ChatGrantAdmissionProvenanceSchema,
    ImplementationPlanGrantAdmissionProvenanceSchema,
    InternalAdmissionProvenanceSchema,
  ])
  .openapi('ToolAdmissionProvenance');

/**
 * What the host did to a tool result's text before the model saw it, when it did anything: cut a
 * long failure message, or replaced an oversized result with guidance. Separate from the
 * remediation, which says why a call failed; a result can carry both.
 */
export const ToolOutputTransformSchema = z
  .enum(['truncated', 'replaced'])
  .describe('Host transformation applied to the result text: `truncated` cut it, `replaced` swapped it for guidance.')
  .openapi('ToolOutputTransform');

const ToolResponseEventV2BaseSchema = z.object({
  ...LLMToolMessageSchema.omit({ role: true }).shape,
  type: z.literal(EventType.TOOL_RESPONSE_V2).describe('Versioned terminal result with an explicit host disposition.'),
  id: EventIdSchema,
  thread_id: z.string().describe('Thread that owns the tool call.'),
  created_at: z.string().describe('ISO 8601 event timestamp.'),
  admission_provenance: ToolAdmissionProvenanceSchema,
  screen: ToolOutputScreenDecisionSchema.optional().describe(
    'Host-owned prompt-injection screen decision for an open-world tool result.',
  ),
  memoized: z.literal(true).optional().describe("The result was replayed from this turn's tool-call memo."),
  repeat_count: z.number().int().positive().optional().describe('Number of identical calls observed this turn.'),
  output_transform: ToolOutputTransformSchema.optional().describe(
    'Present when the host changed the result text before the model saw it.',
  ),
});

const ToolResponseEventV2WithOptionalRemediationSchema = z.object({
  ...ToolResponseEventV2BaseSchema.shape,
  disposition: z.enum(['denied', 'executed_ok', 'executed_nonzero']),
  remediation: ToolResultRemediationSchema.optional(),
});

const ToolResponseEventV2WithRequiredRemediationSchema = z.object({
  ...ToolResponseEventV2BaseSchema.shape,
  disposition: z.enum(['policy_blocked', 'never_ran', 'outcome_unknown']),
  remediation: ToolResultRemediationSchema,
});

export const ToolResponseEventV2Schema = z
  .discriminatedUnion('disposition', [
    ToolResponseEventV2WithOptionalRemediationSchema,
    ToolResponseEventV2WithRequiredRemediationSchema,
  ])
  .openapi('ToolResponseEventV2');

export type ToolResultDisposition = z.infer<typeof ToolResultDispositionSchema>;
export type ToolResultRemediation = z.infer<typeof ToolResultRemediationSchema>;
export type ToolOutputTransform = z.infer<typeof ToolOutputTransformSchema>;
export type ToolAdmissionProvenance = z.infer<typeof ToolAdmissionProvenanceSchema>;
export type ToolResponseEventV2 = z.infer<typeof ToolResponseEventV2Schema>;

interface CreateToolResponseV2Input {
  id: string;
  thread_id: string;
  tool_call_id: string;
  created_at: string;
  raw_content: string;
  model_content: string | null;
  screen: ToolOutputScreenDecision | null;
  admission_provenance: ToolAdmissionProvenance;
  memoized: boolean;
  repeat_count: number;
  disposition: ToolResultDisposition;
  remediation: ToolResultRemediation | undefined;
  /** Optional so existing callers of this public helper keep compiling; omitted from the event when absent. */
  output_transform?: ToolOutputTransform | undefined;
}

function parseToolResultContent(rawContent: string): unknown {
  try {
    return JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
}

/** Canonical constructor for every host-produced terminal tool result. */
export function createToolResponseV2(input: CreateToolResponseV2Input): {
  event: ToolResponseEventV2;
  model_message: z.infer<typeof LLMToolMessageSchema>;
} {
  const outcome = {
    disposition: input.disposition,
    ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
    ...(input.screen === null ? {} : { screen: input.screen }),
  };
  const content = JSON.stringify({
    schema_version: EventType.TOOL_RESPONSE_V2,
    outcome,
    // A screened event retains the exact provider text as a JSON string. That keeps the original
    // bytes recoverable and user-visible without exposing them to the model-facing message below.
    result: input.screen === null ? parseToolResultContent(input.raw_content) : input.raw_content,
  });
  const modelContent =
    input.model_content === null && input.screen === null
      ? content
      : JSON.stringify({
          schema_version: EventType.TOOL_RESPONSE_V2,
          outcome,
          result: parseToolResultContent(input.model_content ?? input.raw_content),
        });
  const event = ToolResponseEventV2Schema.parse({
    type: EventType.TOOL_RESPONSE_V2,
    id: input.id,
    thread_id: input.thread_id,
    tool_call_id: input.tool_call_id,
    created_at: input.created_at,
    content,
    disposition: input.disposition,
    ...(input.screen === null ? {} : { screen: input.screen }),
    ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
    ...(input.output_transform === undefined ? {} : { output_transform: input.output_transform }),
    admission_provenance: input.admission_provenance,
    ...(input.memoized ? { memoized: true, repeat_count: input.repeat_count } : {}),
  });
  return {
    event,
    model_message: { role: 'tool', tool_call_id: input.tool_call_id, content: modelContent },
  };
}

/**
 * Durable boundary immediately before a side-effecting tool call may be
 * dispatched. A missing terminal tool.response after this event is an unknown
 * outcome, never evidence that it is safe to replay the call.
 */
export const ToolExecutionStartedEventSchema = z
  .object({
    type: z.literal(EventType.TOOL_EXECUTION_STARTED).describe('A side-effecting tool call is about to be dispatched.'),
    id: EventIdSchema,
    thread_id: z.string().describe('Thread that owns the tool call.'),
    tool_call_id: z.string().describe('Id of the tool call about to be dispatched.'),
    tool_name: z.string().describe('Model-visible name of the tool about to be dispatched.'),
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    command_execution: RegisteredCommandExecutionSchema.optional().describe(
      'Host-resolved registered-command execution metadata; absent for every other tool.',
    ),
  })
  .openapi('ToolExecutionStartedEvent');

/** Internal durable replay checkpoint, retained in thread context rather than emitted to clients. */
export const ToolExecutionTrackingContextSchema = z
  .object({
    type: z.literal('internal.tool.execution_tracking'),
    tool_call_ids: z.array(z.string()),
  })
  .openapi('ToolExecutionTrackingContext');

export const ThreadCreatedEventSchema = z
  .object({
    type: z.literal(EventType.THREAD_CREATED).describe('A dynamic subagent thread was created.'),
    id: EventIdSchema,
    agent_info: AgentInfoSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    parent: AgentParentSchema,
    thread_id: z.string().describe('Id of the new thread.'),
    title: z.string().describe('Human-readable thread title.'),
  })
  .openapi('ThreadCreatedEvent');

export const ThreadStateDoneSchema = z
  .object({
    status: z.literal('done').describe('Thread completed successfully.'),
    output: ModelMessageEventSchema,
  })
  .openapi('ThreadStateDone');

export const ThreadStateErrorSchema = z
  .object({
    status: z.literal('error').describe('Thread ended with an error.'),
    error: z.string().describe('Human-readable error message.'),
    output: ModelMessageEventSchema.optional(),
  })
  .openapi('ThreadStateError');

export const ThreadStateSchema = z
  .discriminatedUnion('status', [ThreadStateDoneSchema, ThreadStateErrorSchema])
  .openapi('ThreadState');

export const BaseThreadDoneEventSchema = z
  .object({
    parent: AgentParentSchema.optional(),
    thread_id: z.string().describe('Thread that finished.'),
    title: z.string().describe('Human-readable thread title.'),
  })
  .openapi('BaseThreadDoneEvent');

export const ThreadDoneEventSchema = BaseThreadDoneEventSchema.extend({
  type: z.literal(EventType.THREAD_DONE).describe('A thread reached a terminal state.'),
  id: EventIdSchema,
  created_at: z.string().describe('ISO 8601 event timestamp.'),
  state: ThreadStateSchema,
}).openapi('ThreadDoneEvent');

const ContextMessageSchema = z.union([
  LLMUserMessageSchema,
  LLMSystemMessageSchema,
  InternalEnrichedAssistantMessageSchema,
  LLMToolMessageSchema,
  AgentApprovalDecisionMessageSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionTrackingContextSchema,
]);

export const ThreadOverwriteContextEventSchema = z.object({
  // TODO(agent): This will be used by summarization.

  // TODO(agent): For summarization, we will add a AgentExecutionContextSummarizationStart and AgentExecutionContextSummarizationEnd
  // event. Summarization can take some time, this will ensure that the customer is aware of what is happening.
  type: z.literal(EventType.AGENT_CONTEXT_OVERWRITE),
  id: EventIdSchema,
  created_at: z.string(),
  thread_id: z.string(),

  // NOTE: add other reasons here.
  reason: z.enum(['compaction', 'compaction_truncation_fallback']),
  context: z.array(ContextMessageSchema),
  current_context_usage: CurrentContextUsageSchema,
  usage: CompletionUsageSchema,
});

/**
 * Durable, client-visible record that context compaction ran, carried alongside (or instead of,
 * on a skip) `agent.context.overwrite`. Counts only, never the summary text, so it is safe to
 * surface in the session timeline and in a bug-report bundle unredacted. `mode` records which
 * template was used (see ContextCompaction.ts); `outcome` distinguishes a successful overwrite
 * from a skip so a skip stays visible instead of silently vanishing.
 */
export const ContextCompactionEventSchema = z
  .object({
    type: z.literal(EventType.AGENT_CONTEXT_COMPACTION).describe('A context-compaction attempt completed.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    thread_id: z.string().describe('Thread the compaction ran on.'),
    mode: z.enum(['coding', 'conversation']).describe('Which host template was used for the summary.'),
    tokens_before: z.number().int().nonnegative().describe('Estimated context tokens before this attempt.'),
    tokens_after: z.number().int().nonnegative().describe('Estimated context tokens after this attempt.'),
    summary_chars: z.number().int().nonnegative().describe('Length of the persisted summary text, in characters.'),
    outcome: z
      .enum(['applied', 'skipped_invalid', 'skipped_blocked', 'truncated_fallback'])
      .describe(
        'applied: context was overwritten with the summary. skipped_invalid: the model produced a malformed ' +
          'summary and the attempt was discarded. skipped_blocked: the turn was cancelled before the attempt ' +
          'could complete. truncated_fallback: no usable summary was produced, so old turns were truncated instead.',
      ),
    reason: z
      .enum([
        'missing_block',
        'missing_section',
        'duplicate_section',
        'self_referential',
        'over_length',
        'summarizer_failed',
        'request_too_large',
      ])
      .optional()
      .describe(
        'Why no summary was applied. missing_block, missing_section, duplicate_section, self_referential, ' +
          'over_length: the summary was invalid. summarizer_failed: the summarization call failed. ' +
          'request_too_large: the summarization request could not fit the model context.',
      ),
  })
  .openapi('ContextCompactionEvent');

export const MCPServerAuthInfoSchema = z
  .object({
    id: z.string().describe('Internal MCP server id.'),
    name: z.string().describe('Configured MCP server name.'),
    auth_url: z.string().describe('URL the user must visit to complete OAuth for this server.'),
  })
  .openapi('MCPServerAuthInfo');

export const BaseMCPAuthRequiredEventSchema = z
  .object({
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    // This is a run-level event, not tied to a single thread.
    thread_id: z.string().nullable().describe('Always null — this is a run-level event.'),
  })
  .openapi('BaseMCPAuthRequiredEvent');

export const MCPAuthRequiredEventSchema = BaseMCPAuthRequiredEventSchema.extend({
  type: z.literal(EventType.MCP_AUTH_REQUIRED).describe('One or more MCP servers need OAuth before tools can run.'),
  mcp_servers: z.array(MCPServerAuthInfoSchema).describe('Servers that need authorization, each with an auth_url.'),
}).openapi('MCPAuthRequiredEvent');

export const MCPServerInitInfoSchema = z
  .object({
    id: z.string().describe('Internal MCP server id.'),
    name: z.string().describe('Configured MCP server name.'),
    session_id: z.string().optional().describe('Optional MCP session id from the transport.'),
    transport_type: z
      .enum(['streamable-http', 'sse'])
      .optional()
      .describe('Transport used to connect to the MCP server.'),
  })
  .openapi('MCPServerInitInfo');

export const MCPInitializeEventSchema = z
  .object({
    type: z.literal(EventType.MCP_INITIALIZE).describe('MCP server(s) initialized for this turn.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    thread_id: z.string().describe('Thread that triggered initialization.'),
    mcp_servers: z.array(MCPServerInitInfoSchema).describe('Servers that were initialized.'),
  })
  .openapi('MCPInitializeEvent');

export const SandboxCreatedEventSchema = z
  .object({
    type: z.literal(EventType.SANDBOX_CREATED).describe('A sandbox was created for this session.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    sandbox_id: z.string().describe('Provider sandbox id.'),
    // This is a run-level event, sandbox once created is reused by all threads,
    // and future turns as well.
    thread_id: z.string().nullable().describe('Always null — sandbox is session-scoped.'),
  })
  .openapi('SandboxCreatedEvent');

/**
 * Progress of one attached file's text extraction, run as a pre-model step in the turn loop (see
 * `AgentThread.extractStagedDocuments`, which extracts staged files one at a time, and
 * `extractDocumentText`'s `onFileProgress` in documents/documentExtraction.ts, which reports the
 * per-file result). A large scanned PDF can spend most of the 180s exec timeout in OCR with the
 * turn stream otherwise silent, so this gives the client something to render ("Reading <file> ...")
 * live, file by file, while it waits: `started` is yielded before that file's extraction begins,
 * and its terminal phase (`finished`/`failed`/`cancelled`) is yielded as soon as it ends, before the
 * next file starts.
 */
export const DocumentIngestionEventSchema = z
  .object({
    type: z
      .literal(EventType.DOCUMENT_INGESTION)
      .describe('Progress of upload-time document text extraction for one attachment.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    thread_id: z.string().describe('Thread that processed the attachment.'),
    file_name: z.string().describe('Original attachment file name.'),
    staged_path: z.string().describe('Sandbox path the attachment was staged at.'),
    phase: z
      .enum(['started', 'finished', 'failed', 'cancelled'])
      .describe('Extraction lifecycle phase this event reports for the file.'),
    method: z
      .string()
      .optional()
      .describe('Extraction method used ("native text", "OCR", or a per-page mix). Present on finished.'),
    page_count: z.number().int().nonnegative().optional().describe('Pages extracted. Present on finished.'),
    issue: z.string().optional().describe('Why extraction failed. Present on failed.'),
    elapsed_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Milliseconds spent extracting this file. Present on finished, failed and cancelled.'),
  })
  .openapi('DocumentIngestionEvent');

export const ToolCallRefSchema = z
  .object({
    id: z.string().describe('Tool call id awaiting action.'),
    source_event_id: z.string().describe('Event id of the model.message that requested the tool call.'),
  })
  .openapi('ToolCallRef');

export const ApprovalToolCallRefSchema = z
  .object({
    ...ToolCallRefSchema.shape,
    tier: TierSchema.optional().describe('Permission tier of the call; absent when the call was not classified.'),
    tier3_card: z
      .union([Tier3CardSchema, z.null()])
      .optional()
      .describe('Plain-language approval card for a Tier 2 or Tier 3 call, or null.'),
    held: z
      .literal(true)
      .optional()
      .describe('Set when a scheduled run held this action for the owner. The run did not wait for an answer.'),
    not_saved: z
      .enum(['too_many', 'helper_agent'])
      .optional()
      .describe('Set when a scheduled run could not save this action for the owner, and why. It will not run.'),
    can_always_allow: z.boolean().optional().describe('Whether the owner may allow this tool for good.'),
    expires_at: z.string().optional().describe('ISO 8601 time after which a held action can no longer be approved.'),
  })
  .openapi('ApprovalToolCallRef');

export const ToolApprovalRequiredEventSchema = z
  .object({
    type: z.literal(EventType.TOOL_APPROVAL_REQUIRED).describe('One or more tool calls need human approval.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    thread_id: z.string().describe('Thread that owns the pending tool calls.'),
    tool_calls: z.array(ApprovalToolCallRefSchema).describe('Tool calls waiting for approval.'),
  })
  .openapi('ToolApprovalRequiredEvent');

export const ToolResponseRequiredEventSchema = z
  .object({
    type: z
      .literal(EventType.TOOL_RESPONSE_REQUIRED)
      .describe('One or more client-side tool calls need a user/tool response.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
    thread_id: z.string().describe('Thread that owns the pending tool calls.'),
    tool_calls: z.array(ToolCallRefSchema).describe('Tool calls waiting for a client response.'),
  })
  .openapi('ToolResponseRequiredEvent');

export const ActionRequiredEventSchema = z
  .discriminatedUnion('type', [
    ToolApprovalRequiredEventSchema,
    ToolResponseRequiredEventSchema,
    MCPAuthRequiredEventSchema,
  ])
  .openapi('ActionRequiredEvent');

/** Neutral harness output-event membership (not an HTTP/OpenAPI AgentResponse aggregate). */
export const AgentOutputEventSchema = z.discriminatedUnion('type', [
  ModelMessageEventSchema,
  ToolExecutionStartedEventSchema,
  ToolResponseEventV2Schema,
  ToolResponseEventSchema,
  ThreadCreatedEventSchema,
  ThreadDoneEventSchema,
  MCPAuthRequiredEventSchema,
  MCPInitializeEventSchema,
  SandboxCreatedEventSchema,
  DocumentIngestionEventSchema,
  ToolApprovalRequiredEventSchema,
  ToolResponseRequiredEventSchema,
]);

export type AgentParent = z.infer<typeof AgentParentSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type UserToolApprovalMessage = z.infer<typeof UserToolApprovalMessageSchema>;
export type UserToolResponseMessage = z.infer<typeof UserToolResponseMessageSchema>;
export type AgentApprovalDecisionMessage = z.infer<typeof AgentApprovalDecisionMessageSchema>;
export type InputTokensBreakdown = z.infer<typeof InputTokensBreakdownSchema>;
export type ModelMessageUsage = z.infer<typeof ModelMessageUsageSchema>;
export type ModelMessageEvent = z.infer<typeof ModelMessageEventSchema>;
export type ModelMessageDeltaEvent = z.infer<typeof ModelMessageDeltaEventSchema>;
export type ToolExecutionStartedEvent = z.infer<typeof ToolExecutionStartedEventSchema>;
export type ToolExecutionTrackingContext = z.infer<typeof ToolExecutionTrackingContextSchema>;
export type ToolResponseEvent = z.infer<typeof ToolResponseEventSchema>;
export type ThreadCreatedEvent = z.infer<typeof ThreadCreatedEventSchema>;
export type ThreadStateError = z.infer<typeof ThreadStateErrorSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type BaseThreadDoneEvent = z.infer<typeof BaseThreadDoneEventSchema>;
export type ThreadDoneEvent = z.infer<typeof ThreadDoneEventSchema>;
export type ThreadOverwriteContextEvent = z.infer<typeof ThreadOverwriteContextEventSchema>;
export type ContextCompactionEvent = z.infer<typeof ContextCompactionEventSchema>;
export type BaseMCPAuthRequiredEvent = z.infer<typeof BaseMCPAuthRequiredEventSchema>;
export type MCPServerAuthInfo = z.infer<typeof MCPServerAuthInfoSchema>;
export type MCPAuthRequiredEvent = z.infer<typeof MCPAuthRequiredEventSchema>;
export type MCPServerInitInfo = z.infer<typeof MCPServerInitInfoSchema>;
export type MCPInitializeEvent = z.infer<typeof MCPInitializeEventSchema>;
export type SandboxCreatedEvent = z.infer<typeof SandboxCreatedEventSchema>;
export type DocumentIngestionEvent = z.infer<typeof DocumentIngestionEventSchema>;
export type ToolApprovalRequiredEvent = z.infer<typeof ToolApprovalRequiredEventSchema>;
export type ToolResponseRequiredEvent = z.infer<typeof ToolResponseRequiredEventSchema>;
export type ActionRequiredEvent = z.infer<typeof ActionRequiredEventSchema>;
export type AgentOutputEvent = z.infer<typeof AgentOutputEventSchema>;
