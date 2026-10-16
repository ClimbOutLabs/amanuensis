import type { Logger } from 'winston';
import { z } from 'zod';
import type { AgentCapability, CapabilityState, JsonValue } from '../capabilities/AgentCapability';
import type { RegisteredPassthroughEvent, WithRegisteredPassthrough } from '../events/PassthroughEvents';
import type {
  ActionRequiredEvent,
  AgentApprovalDecisionMessage,
  AgentInfo,
  AgentInputUserMessage,
  AgentOutputEvent,
  AgentParent,
  BaseMCPAuthRequiredEvent,
  BaseThreadDoneEvent,
  ContextCompactionEvent,
  DocumentIngestionEvent,
  MCPInitializeEvent,
  MCPServerAuthInfo,
  ModelMessageDeltaEvent,
  ModelMessageEvent,
  SandboxCreatedEvent,
  ThreadCreatedEvent,
  ThreadOverwriteContextEvent,
  ThreadStateError,
  ToolApprovalRequiredEvent,
  ToolExecutionStartedEvent,
  ToolExecutionTrackingContext,
  ToolResponseEventV2,
  ToolResponseRequiredEvent,
  UserToolApprovalMessage,
  UserToolResponseMessage,
} from '../events/schema';
import type {
  CompletionUsage,
  InternalEnrichedAssistantMessage,
  LLMSystemMessage,
  LLMToolMessage,
  LLMUserMessage,
} from '../llm/LLMTypes';
import type { ToolCallMemoSnapshot } from '../mcp/executeToolCalls';
import type { SentinelHostContext } from '../permissions';
import type { Sandbox } from '../sandbox/Sandbox';
import type { AgentTracing } from '../tracing/AgentTracing';
import type { AbnormalHandoffCause } from './AbnormalHandoff';
import type { AgentDefinition } from './AgentDefinition';
import type { CurrentContextUsage } from './contextUsage';
import type { HostToolCallPolicy } from './HostToolCallPolicy';
import type { TaskStateSnapshot } from './taskState';

export type { AgentInfo, AgentParent };

/** Canonical string constants for internal (non-wire) orchestration event `type` fields. */
export const InternalEventType = {
  AGENT_CREATE_SUBAGENT: 'internal.agent.create_subagent',
  AGENT_CONTEXT_APPEND: 'internal.agent.context.append',
  AGENT_DONE: 'internal.agent.done',
  // TODO(agent): revisit broader internal.* naming scheme for harness-only event types.
  PASSTHROUGH: 'agent.passthrough',
  MCP_AUTH_REQUIRED: 'internal.mcp.auth_required',
  CAPABILITY_STATE: 'internal.capability.state',
  MODEL_USAGE: 'internal.agent.model_usage',
} as const;

/**
 * Cross-turn capability KV write. Processors emit without `thread_id`
 * ({@link AgentContextProcessorOutput}); AgentThread stamps `thread_id` when yielding.
 */
export interface InternalCapabilityStateEvent {
  type: typeof InternalEventType.CAPABILITY_STATE;
  thread_id: string;
  key: string;
  state: JsonValue;
}

export interface InternalPassthroughEvent {
  type: typeof InternalEventType.PASSTHROUGH;
  event: RegisteredPassthroughEvent;
}

/**
 * Cross-turn billable-usage-only signal. Emitted by a context processor when a
 * model request completed (and consumed tokens) but produced no context change
 * worth persisting — e.g. a compaction attempt discarded for a malformed
 * summary. Folds `usage` into thread metrics without touching context, without
 * an `AGENT_CONTEXT_OVERWRITE`/`AGENT_CONTEXT_APPEND` wire event, and without
 * incrementing any success counter ({@link AgentContextProcessorOutput}).
 */
export interface InternalModelUsageEvent {
  type: typeof InternalEventType.MODEL_USAGE;
  thread_id: string;
  usage: CompletionUsage;
}

export const InternalPassthroughEventSchema: z.ZodType<InternalPassthroughEvent> = z.object({
  type: z.literal(InternalEventType.PASSTHROUGH),
  event: z.custom<RegisteredPassthroughEvent>(),
});

export type InternalMCPServerAuthInfo = MCPServerAuthInfo & {
  thread_ids: string[];
};

export type InternalMCPAuthRequiredEvent = BaseMCPAuthRequiredEvent & {
  type: typeof InternalEventType.MCP_AUTH_REQUIRED;
  mcp_servers: InternalMCPServerAuthInfo[];
};

export type InternalThreadDoneEvent = BaseThreadDoneEvent & {
  type: typeof InternalEventType.AGENT_DONE;
  send_to_parent: LLMToolMessage | undefined;
  handoff_cause?: AbnormalHandoffCause | undefined;
} & ({ status: 'done'; output: ModelMessageEvent } | { status: 'error'; error: string; output?: ModelMessageEvent });

export type LLMContextMessage = LLMUserMessage | LLMSystemMessage | InternalEnrichedAssistantMessage | LLMToolMessage;

export type ContextMessage =
  LLMContextMessage | AgentApprovalDecisionMessage | ToolExecutionStartedEvent | ToolExecutionTrackingContext;

export interface AgentThreadCreateSubAgent {
  type: typeof InternalEventType.AGENT_CREATE_SUBAGENT;
  thread_id: string;
  tool_call_id: string;
  agent_info: AgentInfo;
}

export interface SubAgentCompletionMarker {
  type: 'done' | 'error';
  output: ModelMessageEvent;
  error_message?: string | undefined;
  send_to_parent: LLMToolMessage;
}

export interface AgentThreadAppendContext {
  type: typeof InternalEventType.AGENT_CONTEXT_APPEND;
  thread_id: string;
  context: ContextMessage[];
  output: AgentOutputEvent[];
  current_context_usage?: CurrentContextUsage | undefined;
  completion?: SubAgentCompletionMarker | undefined;
  tool_call_memo: ToolCallMemoSnapshot | undefined;
  /**
   * Host-owned task-state snapshot for this append. Set when the agent opted
   * into a tool-call budget; undefined means "leave the persisted task state
   * untouched" (the feature is off, or this append carries no task-state
   * change). Lets approval/tool-response continuations rebuild the thread
   * with the scratchpad intact.
   */
  task_state: TaskStateSnapshot | undefined;
  /**
   * Set when this append is the host-enforced grounding nudge (a freshness
   * question, see `isFreshnessQuestion`, answered with no retrieval tool
   * called this turn) rather than ordinary model output. Lets a trace or bug
   * report show the nudge fired without inferring it from message content.
   * Additive and optional so existing consumers are unaffected.
   */
  grounding_nudge?: true | undefined;
}

/** Single public send item (no internal LLM tool messages). */
export type AgentSendInput = UserToolApprovalMessage | UserToolResponseMessage | AgentInputUserMessage;

/**
 * Homogeneous public send batch: all user messages, or all approval/tool-response
 * messages. Mixed batches are rejected at the HTTP/orchestrator boundary.
 */
export type AgentThreadSendBatch = AgentInputUserMessage[] | (UserToolApprovalMessage | UserToolResponseMessage)[];

export type AgentThreadEvent =
  | ModelMessageEvent
  | ModelMessageDeltaEvent
  | ToolExecutionStartedEvent
  | ToolResponseEventV2
  | AgentThreadCreateSubAgent
  | AgentThreadAppendContext
  | ThreadOverwriteContextEvent
  | ContextCompactionEvent
  | InternalThreadDoneEvent
  | InternalMCPAuthRequiredEvent
  | InternalCapabilityStateEvent
  | MCPInitializeEvent
  | SandboxCreatedEvent
  | DocumentIngestionEvent
  | ToolApprovalRequiredEvent
  | ToolResponseRequiredEvent
  | InternalPassthroughEvent;

export type AgentThreadExecutionEvent = WithRegisteredPassthrough<
  ThreadCreatedEvent | Exclude<AgentThreadEvent, InternalPassthroughEvent>
>;

export interface AgentThreadExecutionResult {
  output: ModelMessageEvent | null;
  required_actions: ActionRequiredEvent[];
  root_agent_error?:
    | (Pick<ThreadStateError, 'error' | 'output'> & {
        handoff_cause?: AbnormalHandoffCause | undefined;
      })
    | undefined;
}

/** Public send items plus internal LLM tool messages (child→parent delivery). */
export type AgentThreadRuntimeSendInput = AgentSendInput | LLMToolMessage;

/** Public homogeneous batches or an internal LLM tool-message batch. Not barrel-exported. */
export type AgentThreadRuntimeSendBatch = AgentThreadSendBatch | LLMToolMessage[];

export interface AgentThreadSnapshot {
  thread_id: string;
  context: ContextMessage[];
  current_context_usage: CurrentContextUsage;
  parent: AgentParent | null;
  agent_info: AgentInfo | null;
  completion: SubAgentCompletionMarker | null;
  /** Cross-turn capability KV. Keys: capability.state.key; `tfy.` reserved for builtins. */
  capability_state: CapabilityState | null;
  /** Canonical cross-continuation tool-call memo; undefined for legacy snapshots. */
  tool_call_memo: ToolCallMemoSnapshot | undefined;
  /**
   * Host-owned task-state scratchpad (findings + tool-call budget usage).
   * Lives outside the transcript so context compaction can never erase it.
   * Undefined for legacy snapshots; hydrates to an empty state.
   */
  task_state: TaskStateSnapshot | undefined;
}

export interface AgentThreadConstructorInput {
  definition: AgentDefinition;
  threadId: string;
  title: string;
  parent?: AgentParent | undefined;
  agentInfo?: AgentInfo | undefined;
  context?: ContextMessage[] | undefined;
  currentContextUsage?: CurrentContextUsage | undefined;
  preComputedCompletion?: SubAgentCompletionMarker | undefined;
  sandbox?: Sandbox | undefined;
  capabilities?: readonly AgentCapability[] | undefined;
  /**
   * Previous turn's capability_state for hydration. Optional — omit on first
   * turn / fresh sub-agent. The constructor is the sole hydration site.
   */
  capabilityState?: CapabilityState | undefined;
  /** Previous turn's canonical tool-call memo for continuation hydration. */
  toolCallMemo: ToolCallMemoSnapshot | undefined;
  /**
   * Previous request's task-state scratchpad for continuation hydration.
   * Only consumed when `isRequestContinuation` is true; a genuinely new user
   * message always starts from an empty state.
   */
  taskState: TaskStateSnapshot | undefined;
  /**
   * True when this instance continues the same in-flight user request (an
   * approval or tool-response resubmission built a fresh instance from the
   * preceding snapshot, but no new user message started a new request).
   * Only then is the identical-call guard's this-request count hydrated from
   * toolCallMemo's durable callSignatures; otherwise it starts empty so a
   * stale count from an unrelated, already-finished request never counts
   * toward this request's guard.
   */
  isRequestContinuation: boolean | undefined;
  /** Mutable session-owned exact-tool grants shared by root and subagent threads. */
  chatApprovalGrants?: Set<string> | undefined;
  /** Owner-scoped durable plan grants, refreshed at every tool-batch admission boundary. */
  loadImplementationPlanGrants?: (() => Promise<ReadonlySet<string>>) | undefined;
  /**
   * Cap on concurrently dispatched read-only (Phase-A) tool calls per batch,
   * forwarded to executeToolCalls. Undefined falls back to the core default.
   */
  toolDispatchMaxConcurrency?: number | undefined;
  /**
   * Synchronous host policy consulted for every tool call during
   * assistant-message enrichment, before provider dispatch. A block resolves
   * the call as `policy_blocked` with the host message as the tool error.
   * Undefined disables the hook.
   */
  toolCallPolicy?: HostToolCallPolicy | undefined;
  /**
   * Per-tool-call dispatch deadline in milliseconds, forwarded to
   * executeToolCalls. Undefined falls back to the core default.
   */
  toolCallTimeoutMs?: number | undefined;
  /**
   * sandbox/run_code's own dispatch deadline in milliseconds, forwarded to
   * executeToolCalls. Undefined falls back to the core default.
   */
  runCodeToolCallTimeoutMs?: number | undefined;
  /**
   * Bound in milliseconds on waiting for a model call's first output before
   * the turn fails visibly instead of hanging. Undefined falls back to the
   * core default (see DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS).
   */
  modelFirstResponseTimeoutMs?: number | undefined;
  /**
   * Bound in milliseconds on the pre-LLM context processor phase producing
   * progress before the turn fails visibly instead of hanging. Undefined falls
   * back to the core default (DEFAULT_PRE_LLM_PROCESSORS_TIMEOUT_MS).
   */
  preLLMProcessorsTimeoutMs?: number | undefined;
  /**
   * Bound in milliseconds on the sandbox repository refresh before a model call.
   * On timeout the turn continues with the pre-refresh state. Undefined falls
   * back to the core default (DEFAULT_SANDBOX_REFRESH_TIMEOUT_MS).
   */
  sandboxRefreshTimeoutMs?: number | undefined;
  /**
   * Sentinel permission context for this session. Stored as an instance field
   * and passed to executeToolCalls for Tier 3 dispatch verification.
   * Undefined means Sentinel is not active for this thread.
   */
  sentinel?: SentinelHostContext | undefined;
  tracing: AgentTracing;
  logger: Logger;
}
