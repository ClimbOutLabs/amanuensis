import type { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat';
import type { Logger } from 'winston';
import { createDocumentExtractionBudget, type DocumentFileProgress } from '../../documents/documentExtraction';
import type { AgentCapability, CapabilityState } from '../capabilities/AgentCapability';
import type {
  AgentContextProcessorOutput,
  AgentContextProcessorOverwriteContext,
  AgentThreadExecutionContext,
  PostToolCallAgentContextProcessor,
  PreLLMAgentContextProcessor,
  PreLLMEphemeralAgentContextProcessor,
  PreSendContextProcessor,
} from '../capabilities/AgentContextProcessor';
import { ASK_USER_QUESTION_TOOL_NAME } from '../capabilities/builtins/AskUserQuestion';
import { TOKEN_BUDGET_SAFETY_MARGIN } from '../capabilities/builtins/tokenBudgetConstants';
import { resolveMaxOutputTokens } from '../capabilities/builtins/ContextCompaction';
import { extractDocumentsFromSandbox } from '../capabilities/builtins/DocumentTools';
import { SUB_AGENT_IDENTITY } from '../capabilities/builtins/DynamicSubAgents';
import type { ToolResponseProcessor } from '../capabilities/ToolResponseProcessor';
import {
  AgentHarnessError,
  InvalidAgentSendInputError,
  McpConnectionError,
  ToolPolicyBlockedError,
  ToolPreDispatchError,
} from '../errors';
import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import {
  createToolResponseV2,
  EventType,
  newEventId,
  type AgentApprovalDecisionMessage,
  type AgentInfo,
  type AgentOutputEvent,
  type AgentParent,
  type ApprovalDecision,
  type ContextCompactionEvent,
  type DocumentIngestionEvent,
  type MCPInitializeEvent,
  type MCPServerInitInfo,
  type ModelMessageDeltaEvent,
  type ModelMessageEvent,
  type ModelMessageUsage,
  type SandboxCreatedEvent,
  type ThreadOverwriteContextEvent,
  type ToolApprovalRequiredEvent,
  type ToolExecutionStartedEvent,
  type ToolResponseEventV2,
  type ToolResponseRequiredEvent,
  type UserToolApprovalMessage,
  type UserToolResponseMessage,
} from '../events/schema';
import { InstructionBuilder, ROOT_AGENT_IDENTITY } from '../InstructionBuilder';
import type { LLMCreateParamsStreaming } from '../llm/ILLM';
import {
  type CompletionUsage,
  type ExtendedChatCompletionChunk,
  type FinishReason,
  type InternalEnrichedAssistantMessage,
  type InternalEnrichedToolCall,
  type InternalToolCallInfo,
  type LLMToolMessage,
  type LLMUserMessage,
  type RawAssistantMessage,
  type RawAssistantMessageWithUsage,
  type RegisteredCommandExecution,
  type ThinkingBlock,
} from '../llm/LLMTypes';
import { toOpenAIResponseFormat } from '../llm/responseFormat';
import { toOpenAIChatMessage } from '../llm/toOpenAIChatMessage';
import { ESTIMATE_CHARS_PER_TOKEN, estimateTokensForString } from '../llm/usage';
import { ModelOutputRepetitionError, ModelStreamFault } from '../llm/VercelAILLM';
import {
  allowsChatApproval,
  approvalGrantKey,
  effectiveApprovalDecisions,
  effectiveToolAdmissions,
} from '../mcp/approvalGrant';
import { convertMCPServersToTools, type ConvertToolsResult, type MappedMCPTool } from '../mcp/convertMCPServers';
import {
  cloneToolCallMemoState,
  createToolCallMemoState,
  EMPTY_INSPECTION_NUDGE_AT,
  EMPTY_INSPECTION_STOP_AT,
  executeToolCalls,
  FAILED_BATCH_NUDGE_AT,
  FAILED_BATCH_STOP_AT,
  IDENTICAL_CALL_NUDGE_AT,
  IDENTICAL_CALL_STOP_AT,
  NO_PROGRESS_NUDGE_AT,
  NO_PROGRESS_STOP_AT,
  POLICY_BLOCKED_NUDGE_AT,
  POLICY_BLOCKED_STOP_AT,
  prepareSideEffectToolCalls,
  selectRepeatedActionStopMessage,
  shouldStopAfterMemoizedReplay,
  toolCallSignature,
  toToolCallMemoSnapshot,
  type PendingHostNote,
  type PendingHostNoteKind,
  type ToolCallMemoState,
  type ToolCallResult,
} from '../mcp/executeToolCalls';
import { isGithubFileRead } from '../mcp/githubFileContents';
import type { IToolSet, MCPAuthRequired } from '../mcp/IMCPServer';
import { stampSentinelDecision } from '../mcp/ToolSet';
import type { SentinelHostContext } from '../permissions';
import { classifyHostToolCall, toDispatchSentinelContext } from '../permissions';
import type { Sandbox, SandboxInfo } from '../sandbox/Sandbox';
import type { AgentTracing } from '../tracing/AgentTracing';
import { awaitWithAbort, throwIfSignalAborted } from '../util/abort';
import { resolveLocalTime } from '../util/clientTimezone';
import { describeUnknownError, extractErrorLogFields } from '../util/errorLogFields';
import type { AbnormalHandoff, AbnormalHandoffCause, AbnormalHandoffEvidence } from './AbnormalHandoff';
import type { AgentDefinition } from './AgentDefinition';
import type {
  AgentThreadConstructorInput,
  AgentThreadRuntimeSendBatch,
  AgentThreadRuntimeSendInput,
  AgentThreadSnapshot,
} from './AgentThread.types';
import {
  InternalEventType,
  type AgentThreadAppendContext,
  type AgentThreadEvent,
  type ContextMessage,
  type InternalCapabilityStateEvent,
  type InternalMCPAuthRequiredEvent,
  type InternalThreadDoneEvent,
  type SubAgentCompletionMarker,
} from './AgentThread.types';
import {
  currentContextUsageFromCompletion,
  getEmptyCurrentContextUsage,
  mergeCurrentContextUsage,
  type CurrentContextUsage,
} from './contextUsage';
import {
  ABILITY_BOUNDARIES_PROMPT,
  assistantMessageContentToStringForSubAgent,
  EMPTY_ANSWER_NUDGE_MESSAGE,
  emptyInspectionNudgeMessage,
  estimateTokensForContextMessages,
  failedBatchNudgeMessage,
  GROUNDING_NUDGE_MESSAGE,
  hasCalledRetrievalTool,
  hasRetrievalTool,
  hasSentEmptyAnswerNudgeThisTurn,
  hasSentHostNoteThisTurn,
  identicalCallNudgeMessage,
  INTERNAL_SYSTEM_PROMPT,
  internalSystemMessage,
  internalSystemTag,
  isApprovalDecisionMessage,
  isClientSideToolResponseMessage,
  isFreshnessQuestion,
  isInputUserMessage,
  isLLMContextMessage,
  isLLMToolMessage,
  lastUserMessageText,
  makeUnknownToolInfo,
  NO_TASK_NO_TOOLS_PROMPT,
  noProgressNudgeMessage,
  policyBlockedNudgeMessage,
  scanApprovalDecisions,
  SOURCE_DISCOVERY_CONTRACT,
  toEnrichedToolCall,
  toToolCallInfo,
  UNTRUSTED_TOOL_OUTPUT_PROMPT,
} from './contextUtils';
import { DeferredTool } from './DeferredTool';
import { createEmptyAgentThreadMetrics, updateMetricsFromUsage, type AgentThreadMetrics } from './metrics';
import {
  getClosableOpenToolCallOutcomes,
  getClosableOpenToolCalls,
  OpenToolCallCloser,
  unknownOutcomeCloseout,
  type ClosableToolOutcome,
} from './OpenToolCallCloser';
import {
  admitToolCallsForBudget,
  cloneTaskState,
  createTaskState,
  matchesBudgetedTool,
  noteExecutedToolCalls,
  recordTaskFinding,
  renderTaskStateBlock,
  syncTaskPhase,
  taskStateFromSnapshot,
  toTaskStateSnapshot,
  type TaskState,
} from './taskState';
import { TaskStateToolSet } from './TaskStateToolSet';
import {
  buildIngestedDocumentTextPart,
  buildIngestionCancelledNote,
  buildIngestionUnavailableNote,
  isEmptyMessageContent,
  processAgentUserInput,
  type AgentInputUserMessage,
  type DocumentIngestionProgress,
  type StagedDocumentFile,
} from './UserInputMessage';

const DEFAULT_ITERATION_LIMIT = 25;
const INSPECTION_WARNING_LIMIT = 8;
// Hard stop, not a nudge: once discovery reaches this many pre-edit inspection calls in one
// turn with no structured edit yet observed, the turn ends instead of leaning on the model to
// notice INSPECTION_WARNING_LIMIT's nudge (see nextToolCallMemo.inspectionCallsBeforeEdit
// below). Kept well above the nudge so the model has room to act on the warning first; a run
// that ignores it and keeps searching is a loop, not a slow investigation.
const INSPECTION_STOP_LIMIT = 30;
const ASYNC_ITERATOR_ABORTED = Symbol('async-iterator-aborted');

/**
 * Default bound on waiting for a model call's first output before failing the turn visibly.
 * Ten minutes: generous for slow prefill on large-but-legal contexts, tight enough that a
 * provider that accepted the request and went silent never leaves a turn hanging for hours.
 */
export const DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = 600_000;

/**
 * Default bound on the pre-LLM context processor phase producing progress before
 * failing the turn visibly. Five minutes: generous for compaction on large contexts,
 * tight enough that a processor that accepted the hook and went silent never leaves
 * a turn hanging for hours.
 */
export const DEFAULT_PRE_LLM_PROCESSORS_TIMEOUT_MS = 300_000;

/**
 * Default bound on the sandbox repository refresh before a model call. Thirty
 * seconds: the refresh is an optimization for prompt accuracy, not critical path;
 * a hung refresh must not hang the turn.
 */
export const DEFAULT_SANDBOX_REFRESH_TIMEOUT_MS = 30_000;


/**
 * Last-resort ceiling on the assembled model request's text. Input-time guards bound each user
 * message; this is the backstop for the whole assembly. 4M characters (~1M tokens) sits well
 * above any legitimate request and far below a provider-hanging one.
 */
const MAX_MODEL_REQUEST_CHARS = 4_000_000;
const MODEL_FIRST_RESPONSE_TIMEOUT = Symbol('model-first-response-timeout');

/** Human duration for the watchdog timeout in the user-facing error, e.g. "10 minutes", "90 seconds". */
function describeTimeout(timeoutMs: number): string {
  if (timeoutMs < 60_000) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
}

const OPERATION_TIMEOUT = Symbol('operation-timeout');

/**
 * Awaits an operation with a bounded timeout. If the operation settles first, its
 * outcome (value or rejection) is used. If the timeout fires first, returns
 * OPERATION_TIMEOUT; the operation's late settlement is ignored. Late rejections
 * are swallowed to avoid unhandled-rejection noise — the caller has already chosen
 * to proceed without the result.
 */
function awaitWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | typeof OPERATION_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(OPERATION_TIMEOUT); }, timeoutMs);
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Thrown when an async producer stalls without yielding for longer than its
 * no-progress bound. Carries no producer internals; the message is user-facing.
 */
export class NoProgressTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProgressTimeoutError';
  }
}

/**
 * Drains an async iterable with a no-progress watchdog. Each yielded item resets the
 * timer; if no item arrives within timeoutMs, the iterator is asked to close
 * (best-effort, never awaited — a hung producer must not strand the consumer a
 * second time) and the drain rejects with NoProgressTimeoutError.
 */
async function* drainWithNoProgressTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  timeoutMessage: string,
): AsyncGenerator<T, void, unknown> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: IteratorResult<T, unknown>;
      try {
        result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new NoProgressTimeoutError(timeoutMessage)); }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    // Best-effort close; never await a hung iterator during cleanup.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * Waits for the first model chunk with a bounded watchdog. A provider that accepts the request
 * but never produces a first chunk (and never errors) would otherwise leave the turn active
 * indefinitely — observed as a ~4-hour stall with zero model steps. On timeout the stream is
 * asked to close and the caller fails the turn visibly. The timer is cleared the moment the
 * wait settles for any reason (chunk, abort, or error), so it can never fire late.
 */
function nextModelChunkWithFirstResponseTimeout<T, TReturn>(input: {
  iterator: AsyncIterator<T, TReturn, unknown>;
  signal: AbortSignal | undefined;
  requestClose: () => void;
  timeoutMs: number;
}): Promise<IteratorResult<T, TReturn> | typeof ASYNC_ITERATOR_ABORTED | typeof MODEL_FIRST_RESPONSE_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The model went silent: ask the stream to close, but never await cleanup — a hung
      // provider must not strand the turn a second time.
      input.requestClose();
      resolve(MODEL_FIRST_RESPONSE_TIMEOUT);
    }, input.timeoutMs);
    nextAbortableIteratorResult(input).then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // nextAbortableIteratorResult already normalises non-Error rejections; forward as-is.
        reject(error instanceof Error ? error : new Error(describeUnknownError(error), { cause: error }));
      },
    );
  });
}

function mechanicalHandoffEvidence(): AbnormalHandoffEvidence {
  return {
    repository: null,
    verification_receipt: {
      status: 'not_available',
      command: null,
      branch: null,
      head_sha: null,
      state_sha256: null,
    },
  };
}

/** The single runtime boundary that turns an executed host result into its public v2 event. */
export function buildCanonicalToolCallResult(threadId: string, result: ToolCallResult) {
  // A processor that mutates message.content without going through the security screen still
  // marks the fact via outputTransform (see LargeToolResponse, WebSearchRendering); either signal
  // means message.content no longer carries the original provider bytes, so rawContent (left
  // untouched by every processor) is the one that must reach the durable, UI-visible event.
  const contentWasTransformed = result.screen !== undefined || result.outputTransform !== undefined;
  return createToolResponseV2({
    id: newEventId(),
    thread_id: threadId,
    tool_call_id: result.message.tool_call_id,
    created_at: result.completedAt,
    raw_content: contentWasTransformed ? result.rawContent : result.message.content,
    model_content: contentWasTransformed ? result.message.content : null,
    screen: result.screen ?? null,
    disposition: result.disposition,
    remediation: result.remediation,
    output_transform: result.outputTransform,
    admission_provenance: result.admissionProvenance,
    memoized: result.memoized,
    repeat_count: result.repeatCount,
  });
}

function createAsyncIteratorCloseRequest<T, TReturn>(iterator: AsyncIterator<T, TReturn, unknown>): () => void {
  let requested = false;
  return () => {
    if (requested) {
      return;
    }
    requested = true;
    if (iterator.return === undefined) {
      return;
    }
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  };
}

function nextAbortableIteratorResult<T, TReturn>(input: {
  iterator: AsyncIterator<T, TReturn, unknown>;
  signal: AbortSignal | undefined;
  requestClose: () => void;
}): Promise<IteratorResult<T, TReturn> | typeof ASYNC_ITERATOR_ABORTED> {
  const { iterator, signal, requestClose } = input;
  if (!signal) {
    return iterator.next();
  }
  if (signal.aborted) {
    requestClose();
    return Promise.resolve(ASYNC_ITERATOR_ABORTED);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      resolve(ASYNC_ITERATOR_ABORTED);
      // Async generators may ignore cancellation while next() is pending. Ask
      // them to close, but never await cleanup or let a cleanup failure strand
      // the turn in running state.
      requestClose();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    iterator.next().then(
      result => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          requestClose();
          resolve(ASYNC_ITERATOR_ABORTED);
          return;
        }
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          requestClose();
          resolve(ASYNC_ITERATOR_ABORTED);
          return;
        }
        reject(error instanceof Error ? error : new Error(describeUnknownError(error), { cause: error }));
      },
    );
  });
}

async function* iterateAsyncUntilAborted<T>(input: {
  iterable: AsyncIterable<T>;
  signal: AbortSignal | undefined;
}): AsyncGenerator<T, void, unknown> {
  const iterator = input.iterable[Symbol.asyncIterator]();
  const requestClose = createAsyncIteratorCloseRequest(iterator);
  let completed = false;
  try {
    let result = await nextAbortableIteratorResult({ iterator, signal: input.signal, requestClose });
    while (result !== ASYNC_ITERATOR_ABORTED && !result.done) {
      yield result.value;
      result = await nextAbortableIteratorResult({ iterator, signal: input.signal, requestClose });
    }
    completed = result !== ASYNC_ITERATOR_ABORTED;
  } finally {
    if (!completed) {
      requestClose();
    }
  }
}

function toolCallIsTaskProgress(call: InternalEnrichedToolCall): boolean {
  if (call.tool_info.effect === 'commit' || call.tool_info.effect === 'push') {
    return true;
  }
  if (call.tool_info.effect !== 'edit') {
    return false;
  }
  // Generic shell edits include repository setup, backups, and temporary patch
  // files. None proves that tracked source changed. Structured edit tools do.
  return call.function.name !== 'exec';
}

function toolCallConsumesPreEditBudget(call: InternalEnrichedToolCall): boolean {
  // Before a structured edit succeeds, a generic shell command is discovery or
  // setup from the host's perspective. It may write temporary files, clone a
  // repository, or prepare a patch, but none of those proves tracked source
  // changed. Count it against the same bounded budget as explicit inspection.
  return call.tool_info.effect === 'inspect' || call.function.name === 'exec';
}

type AgentThreadState = 'llm-call-required' | 'tool-response-required' | 'user-input-required';

function requestHasAnsweredClarification(context: readonly ContextMessage[]): boolean {
  let requestStart = -1;
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const message = context[index];
    if (message !== undefined && 'role' in message && message.role === 'user') {
      requestStart = index;
      break;
    }
  }
  const questionIds = new Set<string>();
  for (const message of context.slice(requestStart + 1)) {
    if ('role' in message && message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call.tool_info.original_tool_name === ASK_USER_QUESTION_TOOL_NAME) {
          questionIds.add(call.id);
        }
      }
    }
  }
  return context
    .slice(requestStart + 1)
    .some(message => 'role' in message && message.role === 'tool' && questionIds.has(message.tool_call_id));
}

type StepOutcome = 'exit' | 'continue';

interface StepLLMCallOptions {
  /** Sub-agent completion message sent to the parent when the model returns no tool calls and no
   * visible content. `undefined` when the caller does not want a terminal-failure fallback. */
  emptyTerminalFallback: string | undefined;
  // Set by the caller only when the previous stepLLMCall call ended in the empty-answer nudge:
  // that call's response was never durably persisted, but its start/delta stream already reached
  // live clients under this id. Reusing it here (instead of a fresh id) keeps the id a live
  // client folds on identical to the one that ends up in durable output, so the retried answer
  // replaces the discarded stream instead of appearing as a second, unpersisted message.
  retryModelMessageEventId: string | undefined;
}

interface StepLLMCallResult {
  outcome: StepOutcome;
  modelMessageEventId: string;
  retryModelMessageEventId: string | undefined;
}

const VALID_TRANSITIONS: Record<AgentThreadState, AgentThreadState[]> = {
  'llm-call-required': ['tool-response-required', 'user-input-required'],
  'tool-response-required': ['llm-call-required'],
  // user-input-required transitions to:
  //   tool-response-required — after approval decisions are appended (approval flow)
  //   llm-call-required     — after client-side tool responses resolve tool calls directly
  'user-input-required': ['tool-response-required', 'llm-call-required'],
};

function assertValidTransition(from: AgentThreadState, to: AgentThreadState): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

function deriveAgentThreadState(input: {
  context: ContextMessage[];
  chatApprovalGrants: ReadonlySet<string>;
  implementationPlanGrants: ReadonlySet<string>;
}): AgentThreadState {
  const openToolCallIds = getOpenToolCallIds(input.context);
  if (openToolCallIds.size === 0) {
    return 'llm-call-required';
  }

  const assistant = lastAssistantInContext(input.context);
  const decisions = effectiveApprovalDecisions({
    calls: assistant?.tool_calls ?? [],
    decisions: scanApprovalDecisions(input.context),
    chatApprovalGrants: input.chatApprovalGrants,
    implementationPlanGrants: input.implementationPlanGrants,
  });
  const hasPendingApproval = assistant?.tool_calls?.some(
    tc => openToolCallIds.has(tc.id) && tc.tool_info.is_approval_required === true && !decisions.has(tc.id),
  );
  const hasPendingClientSideTool = assistant?.tool_calls?.some(
    tc => openToolCallIds.has(tc.id) && tc.tool_info.is_client_side === true,
  );
  return hasPendingApproval || hasPendingClientSideTool ? 'user-input-required' : 'tool-response-required';
}

function hasToolCalls(message: InternalEnrichedAssistantMessage): boolean {
  return Boolean(message.tool_calls && message.tool_calls.length > 0);
}

/**
 * True when `content` carries at least one visible, non-whitespace character. Handles the plain
 * string shape and the structured-array shape (text and refusal parts); an array that is merely
 * non-empty (e.g. a single part with `text: ''`) is not visible content.
 */
function hasVisibleAssistantText(content: InternalEnrichedAssistantMessage['content']): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(part => {
    const text = 'text' in part ? part.text : 'refusal' in part ? part.refusal : undefined;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

function hasAssistantContent(message: InternalEnrichedAssistantMessage): boolean {
  return hasVisibleAssistantText(message.content);
}

/** True when the message carries reasoning, in either the plain-text or structured-block field. */
function hasReasoningContent(message: InternalEnrichedAssistantMessage): boolean {
  if (message.reasoning_content && message.reasoning_content.trim().length > 0) {
    return true;
  }
  return (message.thinking_blocks ?? []).some(
    (block): block is ThinkingBlock => block.type === 'thinking' && block.thinking.trim().length > 0,
  );
}

function isLegacyIncompleteReasoningMessage(message: ContextMessage): boolean {
  if (!isLLMContextMessage(message) || message.role !== 'assistant' || hasToolCalls(message)) {
    return false;
  }
  return hasReasoningContent(message) && !hasAssistantContent(message);
}

const EMPTY_ANSWER_HOST_NOTE = 'The model produced no answer.';

/**
 * Some OpenAI-compatible reasoning models (observed with Ollama serving Qwen3) can spend an
 * entire turn inside the thinking block and finish with `stop`, no tool calls, and empty content.
 * The host's first response to that shape is a nudge asking for one more step (see the empty-answer
 * nudge in `stepLLMCall`, `hasSentEmptyAnswerNudgeThisTurn`). This only runs for the second attempt,
 * after that nudge already fired: if the model is still empty, replace the (still empty) content
 * with a fixed host note. Never copies reasoning into content — reasoning stays reasoning, replayed
 * as such on the next request rather than duplicated as visible text. Mutates `assistantMessage`
 * in place; a no-op unless the empty-answer shape is present.
 */
function applyEmptyAnswerHostNote(
  assistantMessage: InternalEnrichedAssistantMessage,
  finishReason: FinishReason | null,
): void {
  if (finishReason !== 'stop' || hasToolCalls(assistantMessage) || hasAssistantContent(assistantMessage)) {
    return;
  }
  assistantMessage.content = EMPTY_ANSWER_HOST_NOTE;
}

// Tool call ids issued by the last assistant message that have no matching
// tool response after it. Walks the context tail-first and stops at the last
// assistant message — under the invariant that older assistant tool_calls are
// already resolved, only the last assistant message can have open ids.
function getOpenToolCallIds(context: ContextMessage[]): Set<string> {
  const resolvedToolCallIds = new Set<string>();
  const openToolCallIds = new Set<string>();
  for (let i = context.length - 1; i >= 0; i--) {
    const msg = context[i];
    if (msg === undefined) {
      continue;
    }
    if (!isLLMContextMessage(msg)) {
      continue;
    }
    if (msg.role === 'tool') {
      resolvedToolCallIds.add(msg.tool_call_id);
      continue;
    }
    if (msg.role === 'assistant') {
      for (const tc of msg.tool_calls ?? []) {
        openToolCallIds.add(tc.id);
      }
      for (const id of resolvedToolCallIds) {
        openToolCallIds.delete(id);
      }
      break;
    }
  }
  return openToolCallIds;
}

function lastAssistantInContext(context: ContextMessage[]): InternalEnrichedAssistantMessage | undefined {
  return context.findLast(
    (msg): msg is InternalEnrichedAssistantMessage => isLLMContextMessage(msg) && msg.role === 'assistant',
  );
}

// Open tool calls that block a new user message: the open set minus those OpenToolCallCloser will
// auto-close during preSend. Lets a user message resume a thread whose only open calls are dangling
// regular tool calls (which the closer repairs), while still blocking on approval/client-side/
// sub-agent calls that genuinely need resolution. Takes the already-computed open set; copies it
// since it mutates (deletes) the closable ids.
function getUnclosableOpenToolCallIds(context: ContextMessage[], openToolCallIds: Set<string>): Set<string> {
  const blockingOpenToolCallIds = new Set(openToolCallIds);
  for (const id of getClosableOpenToolCalls(context).keys()) {
    blockingOpenToolCallIds.delete(id);
  }
  return blockingOpenToolCallIds;
}

function buildMCPInitializeEvent(initInfo: MCPServerInitInfo[], threadId: string): MCPInitializeEvent {
  return {
    type: EventType.MCP_INITIALIZE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    thread_id: threadId,
    mcp_servers: initInfo,
  };
}

function buildMCPAuthRequiredEvent(
  authRequirementInfo: MCPAuthRequired[],
  threadId: string,
): InternalMCPAuthRequiredEvent {
  return {
    type: InternalEventType.MCP_AUTH_REQUIRED,
    id: newEventId(),
    created_at: new Date().toISOString(),
    mcp_servers: authRequirementInfo.flatMap(or => or.servers.map(s => ({ ...s, thread_ids: [threadId] }))),
    // threadId identifies which thread triggered auth for each server so AgentThreadOrchestrator can merge
    // auth events across parallel sub-agents by server.
    thread_id: null,
  };
}

function buildSandboxCreatedEvent(info: SandboxInfo): SandboxCreatedEvent {
  return {
    type: EventType.SANDBOX_CREATED,
    id: newEventId(),
    created_at: new Date().toISOString(),
    ...info,
    thread_id: null,
  };
}

function buildDocumentIngestionEvent(progress: DocumentIngestionProgress, threadId: string): DocumentIngestionEvent {
  return {
    type: EventType.DOCUMENT_INGESTION,
    id: newEventId(),
    created_at: new Date().toISOString(),
    thread_id: threadId,
    file_name: progress.fileName,
    staged_path: progress.stagedPath,
    phase: progress.phase,
    ...(progress.method !== undefined && { method: progress.method }),
    ...(progress.pageCount !== undefined && { page_count: progress.pageCount }),
    ...(progress.issue !== undefined && { issue: progress.issue }),
    ...(progress.elapsedMs !== undefined && { elapsed_ms: progress.elapsedMs }),
  };
}

function buildModelMessageEvent({
  assistantMessage,
  threadId,
  finishReason,
  usage,
  id,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  threadId: string;
  finishReason: FinishReason | null;
  usage: ModelMessageUsage | undefined;
  id: string;
}): ModelMessageEvent {
  // `thinking_blocks` / `source` stay on the context message for replay; strip them from the client event.
  const { role, tool_calls, thinking_blocks, reasoning_content, source, content, ...rest } = assistantMessage;
  void role;
  void thinking_blocks;
  void reasoning_content;
  void source;
  const event: ModelMessageEvent = {
    ...rest,
    // Tool-only completions store content: null on context (OpenAI replay) but the
    // SSE placeholder omits the field. Drop null/empty here so listTurnEvents JSON
    // matches a folded stream.
    ...(content && { content }),
    tool_calls: tool_calls?.map(toEnrichedToolCall),
    type: EventType.MODEL_MESSAGE,
    id,
    created_at: new Date().toISOString(),
    thread_id: threadId,
    finish_reason: finishReason,
    ...(usage && { usage }),
  };
  return event;
}

function validateUserMessage(
  message: { content: AgentInputUserMessage['content'] },
  blockingOpenToolCallIds: Set<string>,
  index: number,
): void {
  if (isEmptyMessageContent(message.content)) {
    throw new InvalidAgentSendInputError(`messages[${String(index)}] user message has empty content`);
  }
  if (blockingOpenToolCallIds.size > 0) {
    throw new InvalidAgentSendInputError('user message cannot be sent while approvals or questions are pending');
  }
}

function validateToolMessage(
  message: LLMToolMessage | UserToolResponseMessage,
  openToolCallIds: Set<string>,
  index: number,
): void {
  if (!openToolCallIds.has(message.tool_call_id)) {
    throw new InvalidAgentSendInputError(
      `messages[${String(index)}] no open tool call for tool_call_id '${message.tool_call_id}'`,
    );
  }
}

function validateApprovalMessage(
  message: UserToolApprovalMessage,
  pendingApprovals: ReadonlyMap<string, InternalEnrichedToolCall>,
  index: number,
): void {
  const pending = pendingApprovals.get(message.tool_call_id);
  if (pending === undefined) {
    throw new InvalidAgentSendInputError(
      `messages[${String(index)}] no pending approval for tool_call_id '${message.tool_call_id}'`,
    );
  }
  if (
    message.approval.status === 'allow' &&
    message.approval.scope === 'chat' &&
    !allowsChatApproval(pending.tool_info)
  ) {
    throw new InvalidAgentSendInputError(
      `messages[${String(index)}] chat-scoped approval is not available for tool_call_id '${message.tool_call_id}'`,
    );
  }
}

function getPendingApprovalToolCalls(input: {
  context: ContextMessage[];
  chatApprovalGrants: ReadonlySet<string>;
  implementationPlanGrants: ReadonlySet<string>;
}): InternalEnrichedToolCall[] {
  const openToolCallIds = getOpenToolCallIds(input.context);
  const assistant = lastAssistantInContext(input.context);
  const decisions = effectiveApprovalDecisions({
    calls: assistant?.tool_calls ?? [],
    decisions: scanApprovalDecisions(input.context),
    chatApprovalGrants: input.chatApprovalGrants,
    implementationPlanGrants: input.implementationPlanGrants,
  });
  return (assistant?.tool_calls ?? []).filter(
    tc => openToolCallIds.has(tc.id) && tc.tool_info.is_approval_required === true && !decisions.has(tc.id),
  );
}

function getPendingClientSideToolCalls(context: ContextMessage[]): InternalEnrichedToolCall[] {
  const openToolCallIds = getOpenToolCallIds(context);
  const assistant = lastAssistantInContext(context);
  return (assistant?.tool_calls ?? []).filter(tc => openToolCallIds.has(tc.id) && tc.tool_info.is_client_side === true);
}

function validateInputMessageTypesGivenContext(input: {
  context: ContextMessage[];
  messages: AgentThreadRuntimeSendInput[];
  chatApprovalGrants: ReadonlySet<string>;
  implementationPlanGrants: ReadonlySet<string>;
}): void {
  // Full open set: validates incoming tool responses and dedupes within the batch.
  const openToolCallIds = getOpenToolCallIds(input.context);
  // Subset that blocks a fresh user message: excludes calls OpenToolCallCloser will auto-close
  // during preSend, so a dangling regular tool call doesn't reject a user message it will repair.
  const blockingOpenToolCallIds = getUnclosableOpenToolCallIds(input.context, openToolCallIds);
  const pendingApprovalCalls = new Map(
    getPendingApprovalToolCalls({
      context: input.context,
      chatApprovalGrants: input.chatApprovalGrants,
      implementationPlanGrants: input.implementationPlanGrants,
    }).map(tc => [tc.id, tc] as const),
  );
  const pendingApprovalIds = new Set(pendingApprovalCalls.keys());
  const pendingClientSideIds = new Set(getPendingClientSideToolCalls(input.context).map(tc => tc.id));

  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i];
    if (m === undefined) {
      continue;
    }
    if (isApprovalDecisionMessage(m)) {
      validateApprovalMessage(m, pendingApprovalCalls, i);
      pendingApprovalCalls.delete(m.tool_call_id);
      pendingApprovalIds.delete(m.tool_call_id);
    } else if (isInputUserMessage(m)) {
      validateUserMessage(m, blockingOpenToolCallIds, i);
    } else if (isClientSideToolResponseMessage(m) || isLLMToolMessage(m)) {
      validateToolMessage(m, openToolCallIds, i);
      openToolCallIds.delete(m.tool_call_id);
      blockingOpenToolCallIds.delete(m.tool_call_id);
      pendingClientSideIds.delete(m.tool_call_id);
    } else {
      const _exhaustive: never = m;
      throw new InvalidAgentSendInputError(
        `messages[${String(i)}] has unsupported type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }

  // A send for a thread awaiting user input must resolve every pending approval and client-side
  // tool call in the same batch; any left unresolved (including an empty batch) is a blocker.
  if (pendingApprovalIds.size > 0 || pendingClientSideIds.size > 0) {
    const missing = [...pendingApprovalIds, ...pendingClientSideIds];
    throw new InvalidAgentSendInputError(
      `Send batch must resolve all pending tool calls awaiting user input. Missing: ${missing.join(', ')}`,
    );
  }
}

async function buildModelMessageDeltaEvent({
  chunk,
  threadId,
  toolMapping,
  usage,
  id,
  logger,
}: {
  chunk: ExtendedChatCompletionChunk;
  threadId: string;
  toolMapping: Map<string, MappedMCPTool>;
  usage: ModelMessageUsage | undefined;
  id: string;
  logger: Logger;
}): Promise<ModelMessageDeltaEvent | undefined> {
  const choice = chunk.choices[0];
  const delta = choice?.delta;
  const finishReason = choice?.finish_reason;

  if (!delta || (Object.keys(delta).length === 0 && !finishReason && !usage)) {
    return;
  }

  // Drop empty deltas that carry no displayable or actionable data
  if (!delta.tool_calls?.length && !delta.content && !delta.reasoning_content && !finishReason && !usage) {
    return;
  }

  const toolCalls = delta.tool_calls ?? [];
  for (const toolCall of toolCalls) {
    if (toolCall.function?.name) {
      const toolInfo = toolMapping.get(toolCall.function.name);
      if (!toolInfo) {
        logger.warn(`LLM called unknown tool: Tool ${toolCall.function.name} not found in tool mapping.`);
        toolCall.tool_info = toToolCallInfo(makeUnknownToolInfo(toolCall.function.name));
        continue;
      }
      toolCall.tool_info = toToolCallInfo(
        await resolveToolCallInfo({
          toolInfo,
          params: { name: toolInfo.originalToolName },
          resolveUnderlyingTool: false,
        }),
      );
    }
  }

  // Strip legacy `function_call` and replay-only `thinking_blocks` so neither reaches the client or delta stream.
  const { role, function_call, thinking_blocks, ...deltaWithoutRole } = delta;
  void role;
  void function_call;
  void thinking_blocks;
  return {
    ...deltaWithoutRole,
    type: EventType.MODEL_MESSAGE_DELTA,
    id,
    thread_id: threadId,
    ...(finishReason && { finish_reason: finishReason }),
    ...(usage && { usage }),
  };
}

async function resolveToolCallInfo({
  toolInfo,
  params,
  resolveUnderlyingTool,
}: {
  toolInfo: MappedMCPTool;
  params: { name: string; arguments?: Record<string, unknown> | undefined };
  resolveUnderlyingTool: boolean;
}): Promise<InternalToolCallInfo> {
  try {
    return await toolInfo.toolSet.toolCallInfo(params, resolveUnderlyingTool);
  } catch (error) {
    const unavailableMcp = findUnavailableMcpCause(error);
    if (unavailableMcp !== undefined) {
      // Metadata discovery can reach the remote MCP server. An unavailable
      // connector must not kill the turn or be mistaken for a host policy
      // denial. Fail closed by requiring approval, then let dispatch record
      // the actual terminal execution disposition if the user proceeds.
      return {
        type: 'mcp',
        mcp_server_id: toolInfo.toolSet.id,
        mcp_server_name: toolInfo.toolSet.name,
        original_tool_name: toolInfo.originalToolName,
        is_approval_required: true,
        is_client_side: false,
        description: `Tool metadata unavailable: ${describeUnknownError(unavailableMcp)}`,
      };
    }
    return {
      type: 'mcp',
      mcp_server_id: toolInfo.toolSet.id,
      mcp_server_name: toolInfo.toolSet.name,
      original_tool_name: toolInfo.originalToolName,
      is_approval_required: false,
      is_client_side: false,
      pre_dispatch_failure: {
        kind: error instanceof ToolPolicyBlockedError ? 'policy_blocked' : 'pre_dispatch_failed',
        message: error instanceof Error ? error.message : 'Tool preparation failed before provider dispatch',
      },
    };
  }
}

function sameRegisteredCommandExecution(
  approved: RegisteredCommandExecution,
  current: RegisteredCommandExecution,
): boolean {
  return (
    approved.repository_id === current.repository_id &&
    approved.repository_revision === current.repository_revision &&
    approved.command_id === current.command_id &&
    approved.command === current.command &&
    approved.cwd === current.cwd &&
    approved.timeout_ms === current.timeout_ms
  );
}

async function enforceRegisteredCommandApprovalIdentity({
  calls,
  toolMapping,
}: {
  calls: readonly InternalEnrichedToolCall[];
  toolMapping: Map<string, MappedMCPTool>;
}): Promise<InternalEnrichedToolCall[]> {
  const checked: InternalEnrichedToolCall[] = [];
  for (const call of calls) {
    const approved = call.tool_info.command_execution;
    if (approved === undefined) {
      checked.push(call);
      continue;
    }
    const toolInfo = toolMapping.get(call.function.name);
    const current =
      toolInfo === undefined
        ? undefined
        : (
            await resolveToolCallInfo({
              toolInfo,
              params: {
                name: toolInfo.originalToolName,
                arguments: tryParseToolArgs(call.function.arguments),
              },
              resolveUnderlyingTool: true,
            })
          ).command_execution;
    if (current !== undefined && sameRegisteredCommandExecution(approved, current)) {
      checked.push(call);
      continue;
    }
    checked.push({
      ...call,
      tool_info: {
        ...call.tool_info,
        pre_dispatch_failure: {
          kind: 'policy_blocked',
          message:
            'The registered command changed after approval. The previous approval was not used; review and approve the current command before running it.',
        },
      },
    });
  }
  return checked;
}

function findUnavailableMcpCause(error: unknown): McpConnectionError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof McpConnectionError &&
      current.statusCode >= 500 &&
      !(current instanceof ToolPreDispatchError)
    ) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Sentinel classification for tool calls whose toolset left them unstamped.
 * MCP servers (ToolSet) and the sandbox classify their own tools with
 * normalized arguments; built-in host tools (LocalToolMCP) do not, so an
 * unrecognized builtin would otherwise execute with no permission check.
 * Classifying here, the single funnel every tool call passes through with
 * its final arguments, covers all sources uniformly. Calls that already
 * carry a tier are never re-classified.
 *
 * Client-side tools run on the client and thread-creation calls are
 * orchestration, not host-executed data actions, so the host has nothing to
 * gate there; they keep the toolset's own stamping. A created sub-agent's
 * own calls are classified in its own thread.
 */
export async function classifyUnstampedToolCall(input: {
  sentinel: SentinelHostContext | undefined;
  canonical_params: Record<string, unknown>;
  info: InternalToolCallInfo;
}): Promise<InternalToolCallInfo> {
  const { sentinel, canonical_params, info } = input;
  if (
    sentinel === undefined ||
    info.tier !== undefined ||
    info.pre_dispatch_failure !== undefined ||
    info.is_client_side === true ||
    info.is_thread_creation === true
  ) {
    return info;
  }
  const decision = await classifyHostToolCall({
    sentinel,
    repository_id: null,
    workspace_cwd: sentinel.workspace_cwd,
    action: {
      tool_name: info.original_tool_name,
      canonical_params,
      tool_type: info.type,
      mcp_hints: {
        read_only_hint: info.read_only_hint,
        destructive_hint: info.destructive_hint,
        open_world_hint: info.open_world_hint,
      },
    },
  });
  return { ...info, ...stampSentinelDecision({ decision }) };
}

async function enrichAssistantMessage({
  assistantMessage,
  toolMapping,
  resolveUnderlyingTool,
  sentinel,
}: {
  assistantMessage: RawAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  resolveUnderlyingTool: boolean;
  sentinel: SentinelHostContext | undefined;
}): Promise<InternalEnrichedAssistantMessage> {
  // Omit tool_calls when empty; OpenAI rejects `tool_calls: []` on replay.
  if (!assistantMessage.tool_calls?.length) {
    const { tool_calls, ...rest } = assistantMessage;
    void tool_calls;
    return rest;
  }

  // Sequential loop instead of Promise.all: the first call populates the MCP server's tool cache
  // (via listTools), making subsequent calls instant cache hits.
  // No race conditions either way but parallelism buys nothing here.
  const enrichedToolCalls = [];
  for (const toolCall of assistantMessage.tool_calls) {
    const toolInfo = toolMapping.get(toolCall.function.name);
    if (!toolInfo) {
      enrichedToolCalls.push({ ...toolCall, tool_info: makeUnknownToolInfo(toolCall.function.name) });
      continue;
    }
    const params = {
      name: toolInfo.originalToolName,
      ...(resolveUnderlyingTool ? { arguments: tryParseToolArgs(toolCall.function.arguments) } : {}),
    };
    const resolved = await resolveToolCallInfo({ toolInfo, params, resolveUnderlyingTool });
    const tool_info = await classifyUnstampedToolCall({
      sentinel,
      canonical_params: params.arguments ?? {},
      info: resolved,
    });
    enrichedToolCalls.push({ ...toolCall, tool_info });
  }
  return { ...assistantMessage, tool_calls: enrichedToolCalls };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Args are only used by DeferredTool to delegate to the underlying server.
// Defensive parse — hallucinated JSON shouldn't crash assistant-message construction.
function tryParseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// State-sync contract: in-memory state must stay consistent with what the consumer
// def foo():
//   for x in range(1, 10):
//   yield x
//   # This cannot raise exception
//   # This does not execute if update_redis fails.
//   update_local_context(x)
// for x in foo():
// # This can raise exception.
// update_redis(x)

/**
 * Breakfix (Sep 27 2026): when the resolved model cannot read images, any
 * `image_url` parts in the assembled request would make the provider reject
 * the entire request (400). Those parts reach here two ways: definition
 * messages authored with images, or chat history from an earlier turn that
 * ran under a vision-capable model. New uploads are already gated by
 * processAgentUserInput; this covers everything else. Each removed image is
 * replaced with a text note so the model sees what happened instead of a
 * silent gap.
 */
export function replaceImagePartsForNonVisionModel(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.map(msg => {
    if (msg.role !== 'user' || typeof msg.content === 'string') {
      return msg;
    }
    const content = msg.content.filter(part => part.type !== 'image_url');
    if (content.length === msg.content.length) {
      return msg;
    }
    return {
      ...msg,
      content: [
        ...content,
        {
          type: 'text',
          text: internalSystemTag('Image omitted: this model cannot process images.'),
        },
      ],
    };
  });
}

export class AgentThread {
  readonly threadId: string;
  readonly parent?: AgentParent | undefined;
  readonly definition: AgentDefinition;
  readonly title: string;
  readonly agentInfo?: AgentInfo | undefined;

  private context: ContextMessage[];
  private currentContextUsage: CurrentContextUsage;
  private preSendContextProcessors: PreSendContextProcessor[];
  private preLLMContextProcessors: PreLLMAgentContextProcessor[];
  private preEphemeralLLMContextProcessors: PreLLMEphemeralAgentContextProcessor[];
  private postToolCallContextProcessor: PostToolCallAgentContextProcessor[];

  private instruction: string | undefined;
  // UTC date the instruction was built with; a mismatch at request time
  // triggers a rebuild so a thread that crosses UTC midnight never sends a
  // stale current-date section.
  private instructionDateUtc: string | undefined;
  private toolResponseProcessors: ToolResponseProcessor[];
  private instructionBuilders: readonly ((builder: InstructionBuilder) => void)[];
  private systemToolSets: readonly IToolSet[];
  private deferredTool?: DeferredTool | undefined;
  private convertedTools: ConvertToolsResult | undefined;
  private pendingSandboxCreatedEvents: SandboxCreatedEvent[] = [];
  // Staged documents awaiting extraction in the turn loop. Set by send() when processAgentUserInput
  // returns stagedDocuments, so extraction yields progress events live over the turn stream instead
  // of batching them after the fact. Extracted text is appended to contextMessages in a pre-model
  // step in execute() before the first LLM call, so the model sees the same content at the same
  // point as before.
  private stagedDocumentsToExtract: readonly StagedDocumentFile[] = [];
  private sandbox?: Sandbox | undefined;
  private readonly tracing: AgentTracing;
  private readonly logger: Logger;

  private metrics: AgentThreadMetrics = createEmptyAgentThreadMetrics();
  private tfyManagedServerNames = new Set<string>();

  private contextBusy = false;
  private preSendRanThisTurn = false;
  // One AgentThread instance lives for one turn (a fresh instance is built per
  // turn by the harness), so this needs no snapshot/restore: it starts false
  // for every turn and latches true the first time the grounding nudge fires,
  // so a turn gets at most one.
  private groundingNudgeSentThisTurn = false;
  // When a loop guard fires, the turn gets one bounded recovery pass: a host
  // note telling the model to write its final answer from gathered results
  // instead of ending with no answer. This latches true so a second guard
  // fire in the same turn ends the turn with the loop_detected error.
  // Same single-turn lifetime as groundingNudgeSentThisTurn above.
  private loopRecoveryAttemptedThisTurn = false;
  // A fresh AgentThread instance is built per turn AND per approval/tool-response
  // continuation of the same turn (the harness rebuilds from the preceding
  // snapshot either way), so this cannot simply start empty in the constructor:
  // an approval continuation must keep counting toward the same request's
  // guard. It is hydrated from toolCallMemo.callSignatures in the constructor
  // only when input.isRequestContinuation is true, and reset alongside
  // toolCallMemo in send() when a genuinely new user message starts a new
  // request, see both sites below. toolCallMemo.callSignatures itself stays
  // untouched here for the persistence contract and any other snapshot consumer.
  private callSignatureCountsThisTurn = new Map<string, number>();
  // Unlike groundingNudgeSentThisTurn, the empty-answer nudge's one-shot-per-turn guard is not an
  // in-memory flag: it is derived from durable context (hasSentEmptyAnswerNudgeThisTurn) so the
  // guard survives a thread reconstructed mid-turn after a restart, rather than resetting to
  // false on a fresh instance and allowing a repeat nudge/provider call.
  private currentState: AgentThreadState | null = null;
  private readonly preComputedCompletion?: SubAgentCompletionMarker | undefined;
  private readonly chatApprovalGrants: Set<string>;
  private readonly loadImplementationPlanGrants?: (() => Promise<ReadonlySet<string>>) | undefined;
  private readonly toolDispatchMaxConcurrency?: number | undefined;
  private readonly toolCallTimeoutMs?: number | undefined;
  private readonly runCodeToolCallTimeoutMs?: number | undefined;
  private readonly modelFirstResponseTimeoutMs: number;
  private readonly preLLMProcessorsTimeoutMs: number;
  private readonly sandboxRefreshTimeoutMs: number;
  private readonly sentinel?: SentinelHostContext | undefined;
  private implementationPlanGrants: ReadonlySet<string> = new Set();
  // One user request may span several execute() calls while approvals are
  // resolved. Keep orchestration limits across those continuations; reset only
  // when a genuinely new user message starts a new request.
  private toolCallMemo = createToolCallMemoState();
  /**
   * Host-owned task-state scratchpad for this user request: structured
   * findings plus tool-call budget usage and phase. Lives outside
   * `this.context` so context compaction can never erase it; re-injected
   * fresh as a `<task_state>` block before every model call. Only meaningful
   * when the agent definition sets `toolCallBudget` — otherwise it stays
   * empty and no block is injected. Advanced only after the tool-results
   * context append is yielded (durable-state ordering); the
   * TaskStateToolSet stages findings separately and never holds this
   * reference, so reassignment here is safe.
   */
  private taskState: TaskState = createTaskState();
  /**
   * The staged-finding delegate, set when the agent opts into a tool-call
   * budget. Owned here so stepToolResponse can drain staged findings after
   * the tool-results append is yielded.
   */
  private taskStateToolSet: TaskStateToolSet | undefined;
  /** Mirrored capability KV — source for toSnapshot().capability_state. */
  private capabilityState: CapabilityState = {};
  private readonly capabilityStateKeys: ReadonlySet<string>;

  constructor(input: AgentThreadConstructorInput) {
    this.tracing = input.tracing;
    this.logger = input.logger.child({ module: 'AgentThread' });
    this.threadId = input.threadId;
    this.definition = input.definition;
    this.context = input.context ? [...input.context] : [];
    this.title = input.title;
    this.parent = input.parent;
    this.currentContextUsage = input.currentContextUsage ?? getEmptyCurrentContextUsage();
    this.agentInfo = input.agentInfo;
    this.preComputedCompletion = input.preComputedCompletion;
    this.sandbox = input.sandbox;
    this.chatApprovalGrants = input.chatApprovalGrants ?? new Set<string>();
    this.loadImplementationPlanGrants = input.loadImplementationPlanGrants;
    this.toolDispatchMaxConcurrency = input.toolDispatchMaxConcurrency;
    this.toolCallTimeoutMs = input.toolCallTimeoutMs;
    this.runCodeToolCallTimeoutMs = input.runCodeToolCallTimeoutMs;
    this.modelFirstResponseTimeoutMs = input.modelFirstResponseTimeoutMs ?? DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS;
    this.preLLMProcessorsTimeoutMs = input.preLLMProcessorsTimeoutMs ?? DEFAULT_PRE_LLM_PROCESSORS_TIMEOUT_MS;
    this.sandboxRefreshTimeoutMs = input.sandboxRefreshTimeoutMs ?? DEFAULT_SANDBOX_REFRESH_TIMEOUT_MS;
    this.sentinel = input.sentinel;
    this.toolCallMemo = createToolCallMemoState(input.toolCallMemo);
    this.toolCallMemo.clarificationAnswered = requestHasAnsweredClarification(this.context);
    // A fresh AgentThread is built per turn AND per approval/tool-response
    // continuation of the same turn (rebuilt from the preceding snapshot), so
    // the scratchpad must hydrate from the snapshot on continuations — but a
    // genuinely new user message always starts empty, never inheriting the
    // previous request's findings or budget usage.
    this.taskState = input.isRequestContinuation ? taskStateFromSnapshot(input.taskState) : createTaskState();
    // Host-owned phase sync at construction: a continuation hydrating a
    // legacy (phase-less) snapshot, or a zero budget, must enter the
    // final-answer phase before the first model call. Idempotent.
    if (input.definition.toolCallBudget !== undefined) {
      syncTaskPhase(this.taskState, input.definition.toolCallBudget);
    }
    this.toolCallMemo.clarificationAnswered = requestHasAnsweredClarification(this.context);
    this.callSignatureCountsThisTurn = input.isRequestContinuation
      ? new Map(this.toolCallMemo.callSignatures)
      : new Map<string, number>();

    const capabilities = input.capabilities ?? [];
    this.systemToolSets = capabilities.flatMap(c => c.systemToolSets ?? []);
    this.preLLMContextProcessors = capabilities.flatMap(c => c.preLLMProcessors ?? []);
    this.preEphemeralLLMContextProcessors = capabilities.flatMap(c => c.preLLMEphemeralProcessors ?? []);
    this.postToolCallContextProcessor = capabilities.flatMap(c => c.postToolCallProcessors ?? []);
    this.toolResponseProcessors = capabilities.flatMap(c => c.toolResponseProcessors ?? []);
    this.instructionBuilders = capabilities.flatMap(c => c.instructionBuilders ?? []);
    const capabilityPreSend = capabilities.flatMap(c => c.preSendProcessors ?? []);
    // OpenToolCallCloser is fixed core before contributed preSend processors.
    this.preSendContextProcessors = [new OpenToolCallCloser(), ...capabilityPreSend];

    assertUniqueStateKeys(capabilities);
    const claimed = claimCapabilityState(capabilities, input.capabilityState, this.logger);
    this.capabilityState = claimed;
    this.capabilityStateKeys = new Set(
      capabilities.map(c => c.state?.key).filter((k): k is string => typeof k === 'string'),
    );
    for (const capability of capabilities) {
      if (!capability.state) {
        continue;
      }
      const value = claimed[capability.state.key];
      if (value !== undefined) {
        capability.state.load(value);
      }
    }

    if (this.definition.toolSets?.length) {
      this.deferredTool = new DeferredTool(this.definition.toolSets, {
        tracing: this.tracing,
        logger: input.logger,
        // Lets call_tool route a mis-addressed host (built-in) tool name to the real
        // host tool instead of failing. See DeferredTool's host-tool routing.
        hostToolSets: this.systemToolSets,
      });
    }

    this.instruction = this.buildInstruction(this.definition.instruction);
  }

  private buildInstruction(userInstruction?: string): string {
    const identity = this.parent ? SUB_AGENT_IDENTITY : ROOT_AGENT_IDENTITY;
    const builder = InstructionBuilder.createSystemPrompt(identity);
    // Ambient, not a tool: a model that must remember to ask for the date will
    // instead assume one from training and reason years into the past, which a
    // live session demonstrated against dated memory retrievals. Date only, no
    // time of day: the prompt prefix then changes once per day instead of
    // every turn, so provider prefix caching keeps working. The
    // get_current_datetime tool remains for precise time.
    this.instructionDateUtc = new Date().toISOString().slice(0, 10);
    const local = resolveLocalTime(new Date(), this.definition.clientTimezone);
    const localDateClause = local.isFallback
      ? ''
      : ` The user's local date is ${local.date} (${local.zone}, UTC${local.utcOffset}).`;
    builder.addSection(
      'current-date',
      `Today's date is ${this.instructionDateUtc} (UTC).${localDateClause} Reason about past and future relative to this date, not to your training data.`,
    );
    // A model whose own release postdates its training data will otherwise
    // insist it doesn't exist, because nothing tells it what it is.
    // `definition.modelId` is the upstream, provider-specific identifier
    // (never the catalog alias), used verbatim: a slash can be part of a
    // valid upstream id (e.g. a Hugging Face style "org/model" id served by
    // vLLM), so it is never stripped here. When no resolver supplies an id,
    // TurnResourceResolver falls back to the catalog FQN (provider/name) and
    // strips the provider prefix itself before it ever reaches
    // `definition.modelId`. Omitted when no identity is resolvable, since a
    // guess would be worse than silence. Sub-agent threads carry
    // `definition.modelId` too (spread from the parent's resolved
    // definition), so they get the same section.
    if (this.definition.modelId) {
      const modelId = this.definition.modelId;
      // Host-owned facts, not a hope that the model behaves: the configured
      // catalog is something the host actually knows, so it is stated
      // outright rather than left to a model that (per upstream guidance and
      // published benchmarks) cannot reliably self-identify or state its own
      // training cutoff. Bounded and stable across a turn's sub-agent threads
      // (all share `definition.configuredModels`) so this never grows the
      // prompt prefix beyond what changes when the catalog itself changes.
      const configuredModels = this.definition.configuredModels;
      const configuredModelsClause =
        configuredModels && configuredModels.length > 0
          ? ` Models configured on this host: ${configuredModels
              .map(model => `${model.modelId} (provider ${model.provider})`)
              .join(', ')}. These exist even if your training data predates them.`
          : '';
      builder.addSection(
        'model-identity',
        `You are running as the model "${modelId}". Your training data ends before this model was released, so newer models, tools and events exist that you have never read about. When the question is what is newest or whether something exists, trust search results and the user over your memory.${configuredModelsClause}`,
      );
    }
    const capabilities = builder.beginSection('agent-capabilities');
    capabilities.addSection('internal-messages', INTERNAL_SYSTEM_PROMPT);
    capabilities.addSection('untrusted-tool-output', UNTRUSTED_TOOL_OUTPUT_PROMPT);
    capabilities.addSection('source-discovery', SOURCE_DISCOVERY_CONTRACT);
    capabilities.addSection('ability-boundaries', ABILITY_BOUNDARIES_PROMPT);
    capabilities.addSection('no-task-no-tools', NO_TASK_NO_TOOLS_PROMPT);

    if (this.sandbox) {
      this.sandbox.buildInstruction(capabilities);
    }
    if (this.deferredTool) {
      this.deferredTool.buildInstruction(capabilities);
    }
    for (const build of this.instructionBuilders) {
      build(capabilities);
    }
    if (!this.parent && userInstruction?.trim()) {
      builder.addSection('user-instructions', userInstruction.trim(), true);
    }
    return builder.build();
  }

  public async *send(
    messages: AgentThreadRuntimeSendBatch,
    signal?: AbortSignal,
    options?: { appendCancellationCleanupAfterAbort?: boolean },
  ): AsyncGenerator<AgentThreadAppendContext, void, unknown> {
    const isInternalToolDelivery = messages.length > 0 && messages.every(isLLMToolMessage);
    if (options?.appendCancellationCleanupAfterAbort === true && messages.some(message => !isLLMToolMessage(message))) {
      throw new InvalidAgentSendInputError('Cancellation cleanup may append only synthetic tool-result messages');
    }
    if (signal?.aborted && !isInternalToolDelivery && options?.appendCancellationCleanupAfterAbort !== true) {
      throwIfSignalAborted(signal);
    }
    if (this.contextBusy && !(options?.appendCancellationCleanupAfterAbort === true && signal?.aborted)) {
      this.throwIfContextBusy();
    }

    this.contextBusy = true;
    try {
      await this.refreshImplementationPlanGrants();
      // An empty batch is a no-op only when the thread is not awaiting user input.
      // While awaiting input, fall through so the validator rejects the empty/incomplete batch.
      if (messages.length === 0 && !this.isAwaitingUserInput()) {
        return;
      }
      for await (const event of this.executeContextProcessors('preSend', signal)) {
        yield event;
      }
      if (signal?.aborted && !isInternalToolDelivery && options?.appendCancellationCleanupAfterAbort !== true) {
        throwIfSignalAborted(signal);
      }
      this.preSendRanThisTurn = true;

      validateInputMessageTypesGivenContext({
        context: this.context,
        messages,
        chatApprovalGrants: this.chatApprovalGrants,
        implementationPlanGrants: this.implementationPlanGrants,
      });
      if (messages.some(isInputUserMessage)) {
        this.toolCallMemo = createToolCallMemoState();
        this.callSignatureCountsThisTurn = new Map<string, number>();
      }

      const approvals: UserToolApprovalMessage[] = [];
      const clientSideToolResponses: UserToolResponseMessage[] = [];
      const contextMessages: (LLMUserMessage | LLMToolMessage)[] = [];

      for (const m of messages) {
        if (isApprovalDecisionMessage(m)) {
          approvals.push(m);
        } else if (isClientSideToolResponseMessage(m)) {
          clientSideToolResponses.push(m);
        } else if (isInputUserMessage(m)) {
          const result = await processAgentUserInput(m, this.sandbox, this.definition.modelSupportsVision ?? false);
          contextMessages.push(result.message);
          if (result.sandboxCreated) {
            this.pendingSandboxCreatedEvents.push(buildSandboxCreatedEvent(result.sandboxCreated));
          }
          if (result.stagedDocuments?.length) {
            this.stagedDocumentsToExtract = result.stagedDocuments;
          }
        } else if (isLLMToolMessage(m)) {
          contextMessages.push(m);
        } else {
          const _exhaustive: never = m;
          throw new InvalidAgentSendInputError(`Unsupported send input: ${JSON.stringify(_exhaustive)}`);
        }
      }

      if (approvals.length > 0 || clientSideToolResponses.length > 0) {
        const pendingById = new Map(
          getPendingApprovalToolCalls({
            context: this.context,
            chatApprovalGrants: this.chatApprovalGrants,
            implementationPlanGrants: this.implementationPlanGrants,
          }).map(call => [call.id, call]),
        );
        for (const approval of approvals) {
          if (approval.approval.status !== 'allow' || approval.approval.scope !== 'chat') {
            continue;
          }
          const pending = pendingById.get(approval.tool_call_id);
          if (
            pending &&
            pending.tool_info.implementation_plan_grant === undefined &&
            allowsChatApproval(pending.tool_info)
          ) {
            this.chatApprovalGrants.add(approvalGrantKey(pending.tool_info));
          }
        }
        const pendingClientCalls = new Map(getPendingClientSideToolCalls(this.context).map(call => [call.id, call]));
        for (const response of clientSideToolResponses) {
          const pending = pendingClientCalls.get(response.tool_call_id);
          if (pending?.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME)) {
            this.toolCallMemo.clarificationAnswered = true;
          }
        }
        const approvalContext: AgentApprovalDecisionMessage[] = approvals.map(a => ({
          type: EventType.USER_TOOL_APPROVAL,
          tool_call_id: a.tool_call_id,
          approval: a.approval,
        }));
        const clientToolResults = clientSideToolResponses.map(m =>
          createToolResponseV2({
            id: newEventId(),
            thread_id: this.threadId,
            tool_call_id: m.tool_call_id,
            created_at: new Date().toISOString(),
            raw_content: m.content,
            model_content: null,
            screen: null,
            disposition: 'executed_ok',
            remediation: undefined,
            admission_provenance: { source: 'internal' },
            memoized: false,
            repeat_count: 1,
          }),
        );
        // Mixed-batch host note: flush any note deferred in stepToolResponse because another call
        // from the same assistant batch (client-side, approval-required, or a sub-agent launch
        // still running) was still open — see nextToolCallMemo.pendingHostNotes there. Flushed only
        // once every tool call of that batch has a result, so the note lands after the last
        // result, never between two results of the same batch.
        const closingMessages: ContextMessage[] = [
          ...approvalContext,
          ...clientToolResults.map(result => result.model_message),
        ];
        const nudgeFlush = this.flushPendingHostNotesIfBatchClosed(closingMessages);

        yield* this.appendToContext({
          context: [...closingMessages, ...nudgeFlush.nudgeMessages],
          output: clientToolResults.map(result => result.event),
          currentContextUsage: undefined,
          usage: undefined,
          ...(nudgeFlush.toolCallMemoAfterFlush === undefined
            ? {}
            : { toolCallMemo: nudgeFlush.toolCallMemoAfterFlush }),
        });
        if (nudgeFlush.toolCallMemoAfterFlush !== undefined) {
          this.toolCallMemo = nudgeFlush.toolCallMemoAfterFlush;
        }
      }
      if (contextMessages.length > 0) {
        // Same mixed-batch flush as above: contextMessages carries a synthetic tool result when a
        // sub-agent launched from this thread's batch has finished (AgentThreadOrchestrator delivers
        // it via this exact path, see buildSubAgentParentToolResponse). A genuine new user message
        // already reset pendingHostNotes to empty above, so the check is a no-op then.
        const nudgeFlush = this.flushPendingHostNotesIfBatchClosed(contextMessages);
        yield* this.appendToContext({
          context: [...contextMessages, ...nudgeFlush.nudgeMessages],
          output: [],
          currentContextUsage: undefined,
          usage: undefined,
          ...(nudgeFlush.toolCallMemoAfterFlush === undefined
            ? {}
            : { toolCallMemo: nudgeFlush.toolCallMemoAfterFlush }),
        });
        if (nudgeFlush.toolCallMemoAfterFlush !== undefined) {
          this.toolCallMemo = nudgeFlush.toolCallMemoAfterFlush;
        }
      }
    } finally {
      this.contextBusy = false;
    }
  }

  private throwIfContextBusy(): void {
    if (this.contextBusy) {
      throw new Error(`context is busy for thread ${this.threadId}`);
    }
  }

  /**
   * Whether appending `closingMessages` to the current context would close every open tool call
   * of the last assistant's batch, and if so, the host notes (see nextToolCallMemo.pendingHostNotes
   * in stepToolResponse — the identical-call repeat guard plus the three streak guards) deferred
   * while that batch had another call still open. Called from both `send()` sites that can close
   * the last open call of a batch: the approval/client-response continuation, and the synthetic
   * tool result a finished sub-agent's launch call receives. Returns an empty flush when the batch
   * is still open, or when there is nothing pending — safe to call unconditionally.
   */
  private flushPendingHostNotesIfBatchClosed(closingMessages: ContextMessage[]): {
    nudgeMessages: LLMUserMessage[];
    toolCallMemoAfterFlush: ToolCallMemoState | undefined;
  } {
    if (this.toolCallMemo.pendingHostNotes.length === 0) {
      return { nudgeMessages: [], toolCallMemoAfterFlush: undefined };
    }
    const projectedContext = this.context.concat(closingMessages);
    const originatingAssistant = lastAssistantInContext(this.context);
    const openIdsAfterFlush = getOpenToolCallIds(projectedContext);
    const batchStillOpenAfterFlush = (originatingAssistant?.tool_calls ?? []).some(call =>
      openIdsAfterFlush.has(call.id),
    );
    if (batchStillOpenAfterFlush) {
      return { nudgeMessages: [], toolCallMemoAfterFlush: undefined };
    }
    const entriesToFlush = this.toolCallMemo.pendingHostNotes.filter(
      entry => !hasSentHostNoteThisTurn(projectedContext, entry.kind, entry.signature),
    );
    const toolCallMemoAfterFlush = cloneToolCallMemoState(this.toolCallMemo);
    toolCallMemoAfterFlush.pendingHostNotes = [];
    return {
      nudgeMessages: entriesToFlush.map(entry => internalSystemMessage(entry.message)),
      toolCallMemoAfterFlush,
    };
  }

  private deriveState(): AgentThreadState {
    const next = deriveAgentThreadState({
      context: this.context,
      chatApprovalGrants: this.chatApprovalGrants,
      implementationPlanGrants: this.implementationPlanGrants,
    });
    if (this.currentState) {
      assertValidTransition(this.currentState, next);
    }
    this.currentState = next;
    return next;
  }

  private *appendToContext(opts: {
    context: ContextMessage[];
    output: AgentOutputEvent[];
    currentContextUsage: CurrentContextUsage | undefined;
    usage: CompletionUsage | undefined;
    completion?: SubAgentCompletionMarker | undefined;
    toolCallMemo?: ToolCallMemoState | undefined;
    groundingNudge?: boolean | undefined;
    /**
     * Explicit next task state to persist with this append. When omitted, the
     * live state is snapshotted — but only when the agent opted into a
     * tool-call budget; otherwise the event carries undefined and the store
     * leaves the persisted task state untouched. Callers that computed a
     * next state (tool-response step) pass it here and advance the live
     * state only after this append is yielded.
     */
    taskState?: TaskState | undefined;
  }): Generator<AgentThreadAppendContext, void, unknown> {
    const { context, output, currentContextUsage, usage, completion, toolCallMemo, groundingNudge, taskState } = opts;

    const newCurrentContextUsage =
      currentContextUsage ??
      mergeCurrentContextUsage(this.currentContextUsage, estimateTokensForContextMessages(context));

    const event: AgentThreadAppendContext = {
      type: InternalEventType.AGENT_CONTEXT_APPEND,
      thread_id: this.threadId,
      context,
      output,
      current_context_usage: newCurrentContextUsage,
      ...(completion && { completion }),
      tool_call_memo: toolCallMemo === undefined ? undefined : toToolCallMemoSnapshot(toolCallMemo),
      task_state:
        this.definition.toolCallBudget === undefined ? undefined : toTaskStateSnapshot(taskState ?? this.taskState),
      ...(groundingNudge && { grounding_nudge: true }),
    };

    // Update metrics before yield so we still count it if the stream stops here.
    if (usage) {
      updateMetricsFromUsage(this.metrics, usage);
    }

    yield event;

    this.context = this.context.concat(context);
    this.currentContextUsage = newCurrentContextUsage;
  }

  private *overwriteContext(
    payload: AgentContextProcessorOverwriteContext,
  ): Generator<ThreadOverwriteContextEvent, void, unknown> {
    const event: ThreadOverwriteContextEvent = {
      thread_id: this.threadId,
      ...payload,
    };
    // Update metrics before yield so we still count it if the stream stops here.
    updateMetricsFromUsage(this.metrics, payload.usage);

    yield event;
    this.context = payload.context;
    this.currentContextUsage = payload.current_context_usage;
    this.metrics.total_summarizations++;
  }

  private generateErrorEvent(
    message: string,
    output?: ModelMessageEvent,
    handoffCause?: AbnormalHandoffCause,
  ): InternalThreadDoneEvent {
    return {
      type: InternalEventType.AGENT_DONE,
      status: 'error',
      thread_id: this.threadId,
      title: this.title,
      error: message,
      parent: this.parent,
      send_to_parent: this.parent
        ? {
            role: 'tool',
            content: message,
            tool_call_id: this.parent.tool_call_id,
          }
        : undefined,
      ...(handoffCause === undefined ? {} : { handoff_cause: handoffCause }),
      ...(output && { output }),
    };
  }

  /**
   * One bounded recovery pass when a loop guard fires. The first fire in a
   * turn appends a host note telling the model to write its final answer from
   * what it has gathered and lets the turn continue; a second fire (the model
   * repeated itself after the note) ends the turn with the loop_detected
   * error. This keeps a stuck turn from ending with no answer at all.
   */
  private *recoverFromLoopOrExit(input: {
    recoveryNote: string;
    errorMessage: string;
  }): Generator<AgentThreadEvent, StepOutcome, unknown> {
    if (this.loopRecoveryAttemptedThisTurn) {
      yield this.generateErrorEvent(input.errorMessage, undefined, 'loop_detected');
      return 'exit';
    }
    this.loopRecoveryAttemptedThisTurn = true;
    yield* this.appendToContext({
      context: [internalSystemMessage(input.recoveryNote)],
      output: [],
      currentContextUsage: undefined,
      usage: undefined,
    });
    return 'continue';
  }

  /** Builds an abnormal terminal handoff after normal execution has stopped. */
  public async buildAbnormalHandoff(input: { cause: AbnormalHandoffCause }): Promise<AbnormalHandoff> {
    let evidence = mechanicalHandoffEvidence();
    if (this.sandbox !== undefined) {
      evidence = await this.sandbox.captureAbnormalHandoffEvidence();
    }
    // The current durable schema has no place for prompt/model/usage lineage.
    // Keep the handoff mechanical until that inference can be represented visibly.
    return { cause: input.cause, summary: null, evidence };
  }

  public hasOpenToolCallId(toolCallId: string): boolean {
    return getOpenToolCallIds(this.context).has(toolCallId);
  }

  // True when this thread is paused waiting on the user to resolve a pending tool
  // approval or a client-side tool response.
  public isAwaitingUserInput(): boolean {
    return (
      getPendingApprovalToolCalls({
        context: this.context,
        chatApprovalGrants: this.chatApprovalGrants,
        implementationPlanGrants: this.implementationPlanGrants,
      }).length > 0 || getPendingClientSideToolCalls(this.context).length > 0
    );
  }

  public async refreshImplementationPlanGrants(): Promise<void> {
    const active = await this.loadImplementationPlanGrants?.();
    this.implementationPlanGrants = new Set(active ?? []);
  }

  // Refreshes owner-scoped plans, then validates without mutating the context.
  public async validateSendInput(messages: AgentThreadRuntimeSendBatch): Promise<void> {
    await this.refreshImplementationPlanGrants();
    validateInputMessageTypesGivenContext({
      context: this.context,
      messages,
      chatApprovalGrants: this.chatApprovalGrants,
      implementationPlanGrants: this.implementationPlanGrants,
    });
  }

  public toSnapshot(): AgentThreadSnapshot {
    const capability_state = Object.keys(this.capabilityState).length > 0 ? { ...this.capabilityState } : null;
    return {
      thread_id: this.threadId,
      context: this.context,
      current_context_usage: this.currentContextUsage,
      parent: this.parent ?? null,
      agent_info: this.agentInfo ?? null,
      completion: this.preComputedCompletion ?? null,
      capability_state,
      tool_call_memo: toToolCallMemoSnapshot(this.toolCallMemo),
      task_state: toTaskStateSnapshot(this.taskState),
    };
  }

  public getAgentThreadMetrics(): AgentThreadMetrics {
    return { ...this.metrics };
  }

  /**
   * Estimates the full request size in tokens: instruction, definition messages,
   * context, task state block, and tool definitions. Used by the token-based
   * pre-flight guard to decide whether compaction must run before the request
   * is assembled. Mirrors the message assembly in transformToLLMRequest without
   * building the full request body.
   *
   * Context messages are estimated text-only (see contextMessageTextTokens):
   * toOpenAIChatMessage preserves image_url / input_audio / file parts with
   * their full base64 payloads, which the conservative chars-per-token
   * heuristic would inflate wildly (a 1MB image reads as ~340k tokens)
   * while the provider does not bill those bytes as text tokens.
   *
   * Bails out early once the running total already exceeds `limit`: this runs on
   * every turn, and precision past the guard threshold buys nothing. Pass
   * Number.POSITIVE_INFINITY when the full estimate is needed (for example for
   * the fail-fast error message).
   */
  private estimateFullRequestTokens(tools: ChatCompletionTool[], limit: number): number {
    let total = 0;
    if (this.instruction) {
      total += estimateTokensForString(this.instruction);
      if (total > limit) {
        return total;
      }
    }
    if (this.definition.messages) {
      for (const msg of this.definition.messages) {
        if (isLLMContextMessage(msg)) {
          total += estimateTokensForString(JSON.stringify(msg));
          if (total > limit) {
            return total;
          }
        }
      }
    }
    for (const message of this.context) {
      total += contextMessageTextTokens(message);
      if (total > limit) {
        return total;
      }
    }
    const taskStateBlock = renderTaskStateBlock({
      state: this.taskState,
      budget: this.definition.toolCallBudget,
    });
    if (taskStateBlock !== null) {
      total += estimateTokensForString(taskStateBlock);
      if (total > limit) {
        return total;
      }
    }
    total += estimateTokensForString(JSON.stringify(tools));
    return total;
  }

  private transformToLLMRequest(tools: ChatCompletionTool[]): LLMCreateParamsStreaming {
    // A long-running thread can cross UTC midnight between LLM steps. Within a
    // day the rebuilt string is byte-identical, so prefix caching is untouched;
    // on a date change the one rebuild trades a single cache miss for a
    // correct current-date section.
    if (this.instruction && this.instructionDateUtc !== new Date().toISOString().slice(0, 10)) {
      this.instruction = this.buildInstruction(this.definition.instruction);
    }

    let messages: ChatCompletionMessageParam[] = [];

    if (this.instruction) {
      messages.push({
        role: 'system',
        content: this.instruction,
      });
    }

    if (this.definition.messages) {
      for (const msg of this.definition.messages) {
        if (isLLMContextMessage(msg)) {
          messages.push(toOpenAIChatMessage(msg));
        }
      }
    }

    // NOTE: all this code-golf is to remove `tool_info` before sending the message to Gateway
    // ApprovalDecisionMessage rows are persisted in context but must not be sent to the LLM.
    const contextMessages = this.context
      .filter(message => !isLegacyIncompleteReasoningMessage(message))
      .filter(isLLMContextMessage)
      .map(msg => toOpenAIChatMessage(msg));

    messages.push(...contextMessages);

    for (const processor of this.preEphemeralLLMContextProcessors) {
      messages = processor.processPreLLMEphemeral(messages) ?? messages;
    }

    // Host-owned task state: re-injected fresh on EVERY model call, after
    // transcript assembly and ephemeral processing. This message is never
    // persisted into `this.context`, so context compaction — which only ever
    // rewrites transcript messages — cannot erase the findings the model has
    // banked. Appended last so the provider-prefix cache over the instruction
    // and transcript is disturbed as little as possible.
    const taskStateBlock = renderTaskStateBlock({
      state: this.taskState,
      budget: this.definition.toolCallBudget,
    });
    if (taskStateBlock !== null) {
      messages.push({ role: 'system', content: taskStateBlock });
    }

    // Breakfix (Sep 27 2026): never send image_url parts to a model that cannot
    // read images; the provider rejects the whole request. Covers history from
    // vision-capable turns and image-bearing definition messages.
    if (!this.definition.modelSupportsVision) {
      messages = replaceImagePartsForNonVisionModel(messages);
    }

    // modelParams may include provider extensions (e.g. reasoning_effort) beyond the SDK's
    // ChatCompletionCreateParamsStreaming field set; assign after constructing the typed body.
    // Model identity is owned by modelClient — do not set `model` on the request.
    const requestBody: LLMCreateParamsStreaming = {
      messages,
      stream: true,
      ...(this.definition.responseFormat !== undefined
        ? { response_format: toOpenAIResponseFormat(this.definition.responseFormat) }
        : {}),
    };
    if (this.definition.modelParams) {
      Object.assign(requestBody, this.definition.modelParams);
    }

    if (tools.length > 0) {
      requestBody.tools = tools;
    }

    return requestBody;
  }

  private computeAssistantMessageUsage(params: {
    requestBody: LLMCreateParamsStreaming;
    usage: CompletionUsage;
    toolMapping: Map<string, MappedMCPTool>;
  }): ModelMessageUsage {
    const { requestBody, usage, toolMapping } = params;
    // Sub-agents have no <user-instructions> section — their agent.instruction is
    // SUB_AGENT_IDENTITY which is harness content, not user-defined instructions.
    const trimmedInstruction = this.definition.instruction?.trim() ?? '';
    const instructionsEstimate = this.parent ? 0 : Math.round(estimateTokensForString(trimmedInstruction));

    const skillsEstimate = this.sandbox?.estimateSkillsTokens() ?? 0;

    let tfyManagedToolTokens = 0;
    let userToolTokens = 0;
    if (requestBody.tools) {
      for (const tool of requestBody.tools) {
        const toolTokens = Math.round(estimateTokensForString(JSON.stringify(tool)));
        const info = 'function' in tool ? toolMapping.get(tool.function.name) : undefined;
        if (info && this.tfyManagedServerNames.has(info.toolSet.name)) {
          tfyManagedToolTokens += toolTokens;
        } else {
          userToolTokens += toolTokens;
        }
      }
    }

    const totalInstructionTokens = Math.round(estimateTokensForString(this.instruction ?? ''));
    const harnessInstructionTokens = Math.max(0, totalInstructionTokens - instructionsEstimate - skillsEstimate);
    const harnessEstimate = harnessInstructionTokens + tfyManagedToolTokens;

    const estimatedComponentsTotal = harnessEstimate + skillsEstimate + instructionsEstimate + userToolTokens;
    const messagesEstimate = Math.max(0, usage.input_tokens - estimatedComponentsTotal);

    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      input_tokens_breakdown: {
        harness: harnessEstimate,
        skills: skillsEstimate,
        instructions: instructionsEstimate,
        tool_definitions: userToolTokens,
        messages: messagesEstimate,
      },
    };
  }

  private executeContextProcessors(
    hook: 'preSend',
    signal?: AbortSignal,
  ): AsyncGenerator<AgentThreadAppendContext, void, unknown>;
  private executeContextProcessors(
    hook: 'preLLM' | 'postToolCall',
    signal?: AbortSignal,
    options?: { forceCompaction?: boolean },
  ): AsyncGenerator<
    | ThreadOverwriteContextEvent
    | ContextCompactionEvent
    | AgentThreadAppendContext
    | { type: typeof InternalEventType.PASSTHROUGH; event: RegisteredPassthroughEvent }
    | InternalCapabilityStateEvent,
    void,
    unknown
  >;
  private async *executeContextProcessors(
    hook: 'preSend' | 'preLLM' | 'postToolCall',
    signal?: AbortSignal,
    options?: { forceCompaction?: boolean },
  ): AsyncGenerator<
    | ThreadOverwriteContextEvent
    | ContextCompactionEvent
    | AgentThreadAppendContext
    | { type: typeof InternalEventType.PASSTHROUGH; event: RegisteredPassthroughEvent }
    | InternalCapabilityStateEvent,
    void,
    unknown
  > {
    let processors: ((
      execution: Readonly<AgentThreadExecutionContext>,
    ) => AsyncIterable<AgentContextProcessorOutput>)[];
    switch (hook) {
      case 'preSend':
        processors = this.preSendContextProcessors.map(p => p.processPreSend.bind(p));
        break;
      case 'preLLM':
        processors = this.preLLMContextProcessors.map(p => p.processPreLLM.bind(p));
        break;
      case 'postToolCall':
        processors = this.postToolCallContextProcessor.map(p => p.processPostToolCall.bind(p));
        break;
      default:
        throw new Error(`Unknown hook: ${String(hook)}`);
    }

    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: this.threadId,
      signal,
      sandbox: this.sandbox,
      ...(signal === undefined ? {} : { signal }),
      currentContextUsage: this.currentContextUsage,
      context: this.context,
      ...(options?.forceCompaction === true ? { forceCompaction: true } : {}),
    };

    for (const processor of processors) {
      if (signal?.aborted) {
        return;
      }
      for await (const response of iterateAsyncUntilAborted({ iterable: processor(execution), signal })) {
        if (signal?.aborted) {
          return;
        }
        switch (response.type) {
          case InternalEventType.AGENT_CONTEXT_APPEND:
            yield* this.appendToContext({
              context: response.context,
              output: response.output,
              currentContextUsage: response.current_context_usage ?? this.currentContextUsage,
              usage: undefined,
            });
            break;
          case EventType.AGENT_CONTEXT_OVERWRITE:
            yield* this.overwriteContext(response);
            break;
          case EventType.AGENT_CONTEXT_COMPACTION:
            // Counts-only record that a compaction attempt ran (see ContextCompaction.ts);
            // carries no context mutation of its own, so just stamp thread_id and forward it.
            yield { ...response, thread_id: this.threadId };
            break;
          case InternalEventType.PASSTHROUGH:
            yield response;
            break;
          case InternalEventType.CAPABILITY_STATE:
            if (!this.capabilityStateKeys.has(response.key)) {
              throw new AgentHarnessError(
                'capability_state_error',
                `CAPABILITY_STATE key '${response.key}' is not declared by any capability on thread '${this.threadId}'`,
              );
            }
            yield {
              type: InternalEventType.CAPABILITY_STATE,
              thread_id: this.threadId,
              key: response.key,
              state: response.state,
            };
            this.capabilityState[response.key] = response.state;
            break;
          case InternalEventType.MODEL_USAGE:
            // A model request completed and consumed billable tokens but produced
            // no context change worth persisting (e.g. a discarded malformed
            // compaction summary). Fold the usage into thread metrics without a
            // context mutation, a wire event, or any success counter.
            updateMetricsFromUsage(this.metrics, response.usage);
            break;
          default: {
            const _exhaustive: never = response;
            return _exhaustive;
          }
        }
        if (signal?.aborted) {
          return;
        }
      }
      if (signal?.aborted) {
        return;
      }
    }
  }

  private async init(): Promise<{
    initializationInfo: MCPServerInitInfo[];
    authRequirementInfo: MCPAuthRequired[];
  }> {
    if (this.convertedTools) {
      return { initializationInfo: [], authRequirementInfo: [] };
    }
    return this.initTools();
  }

  private async initTools(): Promise<{
    initializationInfo: MCPServerInitInfo[];
    authRequirementInfo: MCPAuthRequired[];
  }> {
    const tfyManagedServers: IToolSet[] = [...this.systemToolSets];
    // Host-owned task-state scratchpad: only for agents that opt into a
    // tool-call budget. The tool stages findings; AgentThread folds them into
    // the next task state only after the tool-results append is yielded
    // (durable-state ordering). The banked-count closure always reads the
    // current live state, so later state advances never stale it.
    if (this.definition.toolCallBudget !== undefined) {
      // Built once per thread: initTools() is memoized on this.convertedTools,
      // and a fresh instance per initialization would diverge the restored
      // tool mapping from this.taskStateToolSet on conversion failure,
      // silently dropping staged findings at the drain below.
      this.taskStateToolSet ??= new TaskStateToolSet({
        tracing: this.tracing,
        bankedCount: () => this.taskState.findings.length,
      });
      tfyManagedServers.push(this.taskStateToolSet);
    }
    if (this.sandbox) {
      tfyManagedServers.push(this.sandbox);
    }
    if (this.deferredTool) {
      tfyManagedServers.push(this.deferredTool);
    }
    const userServers = [...(this.definition.toolSets ?? [])];

    const { convertedTools, initializationInfo, authRequirementInfo } = await convertMCPServersToTools({
      tfyManagedServers,
      userServers,
    });
    this.convertedTools = convertedTools;
    this.tfyManagedServerNames = new Set(tfyManagedServers.map(s => s.name));
    return { initializationInfo, authRequirementInfo };
  }

  private getConvertedTools(): ConvertToolsResult {
    if (!this.convertedTools) {
      throw new Error('unreachable');
    }
    return this.convertedTools;
  }

  /**
   * Pre-model extraction of staged documents. Runs once per turn before the first LLM call when
   * documents were uploaded. Yields progress events (started, finished/failed/cancelled per file)
   * live in the turn stream and appends extracted text to context so the model receives it the same
   * way as before, only produced one step later in the turn loop instead of batched at send().
   */
  private async *extractStagedDocuments(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentThreadEvent, void, unknown> {
    if (!this.sandbox) {
      return;
    }

    const files = this.stagedDocumentsToExtract;
    if (files.length === 0) {
      return;
    }

    // Threaded across the per-file calls below so the aggregate byte/page/character/file-count
    // caps from #138 hold across the whole batch even though each file is extracted (and its
    // progress yielded) one at a time. See `DocumentExtractionBudget`.
    const budget = createDocumentExtractionBudget();
    const extractedTextParts: ChatCompletionContentPart[] = [];

    const cancelFrom = function* (remaining: readonly StagedDocumentFile[]) {
      for (const file of remaining) {
        yield { fileName: file.filename, stagedPath: file.path, phase: 'cancelled' as const };
      }
    };

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file === undefined) {
        continue;
      }

      if (signal?.aborted) {
        // Never reached extraction: no `started` event for these, per the cancellation contract.
        for (const progress of cancelFrom(files.slice(index))) {
          yield buildDocumentIngestionEvent(progress, this.threadId);
          extractedTextParts.push(
            buildIngestionCancelledNote({ filename: progress.fileName, path: progress.stagedPath }),
          );
        }
        break;
      }

      yield buildDocumentIngestionEvent(
        { fileName: file.filename, stagedPath: file.path, phase: 'started' },
        this.threadId,
      );

      let terminalDocumentProgress: DocumentFileProgress | undefined;
      try {
        const extraction = await extractDocumentsFromSandbox(
          this.sandbox,
          [file.path],
          signal,
          progress => {
            if (progress.phase !== 'started') {
              terminalDocumentProgress = progress;
            }
          },
          budget,
        );
        const document = extraction.documents[0];
        if (terminalDocumentProgress === undefined && document !== undefined) {
          // Defensive: onFileProgress above should always have fired for the one file requested.
          terminalDocumentProgress = {
            phase: document.pages.length > 0 ? 'finished' : 'failed',
            filename: file.filename,
            path: file.path,
            elapsedMs: 0,
            document,
          };
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // The file currently in flight still gets a terminal event; it never leaves `started`
          // dangling. Remaining, unreached files are cancelled without ever having started.
          yield buildDocumentIngestionEvent(
            { fileName: file.filename, stagedPath: file.path, phase: 'cancelled' },
            this.threadId,
          );
          extractedTextParts.push(buildIngestionCancelledNote({ filename: file.filename, path: file.path }));
          for (const progress of cancelFrom(files.slice(index + 1))) {
            yield buildDocumentIngestionEvent(progress, this.threadId);
            extractedTextParts.push(
              buildIngestionCancelledNote({ filename: progress.fileName, path: progress.stagedPath }),
            );
          }
          return;
        }
        const issue = `Could not read ${file.filename}: ${error instanceof Error ? error.message : String(error)}`;
        yield buildDocumentIngestionEvent(
          { fileName: file.filename, stagedPath: file.path, phase: 'failed', issue, elapsedMs: 0 },
          this.threadId,
        );
        extractedTextParts.push(buildIngestionUnavailableNote({ filename: file.filename, path: file.path }, issue));
        continue;
      }

      if (terminalDocumentProgress === undefined || terminalDocumentProgress.phase === 'started') {
        // Should be unreachable (extraction resolved without ever reporting a terminal phase);
        // still emit a terminal event so `started` is never left dangling.
        const issue = 'Extraction produced no text';
        yield buildDocumentIngestionEvent(
          { fileName: file.filename, stagedPath: file.path, phase: 'failed', issue, elapsedMs: 0 },
          this.threadId,
        );
        extractedTextParts.push(buildIngestionUnavailableNote({ filename: file.filename, path: file.path }, issue));
        continue;
      }

      const document = terminalDocumentProgress.document;
      if (terminalDocumentProgress.phase === 'finished') {
        yield buildDocumentIngestionEvent(
          {
            fileName: file.filename,
            stagedPath: file.path,
            phase: 'finished',
            method:
              document.extraction_mode === 'text'
                ? 'native text'
                : document.extraction_mode === 'ocr'
                  ? 'OCR'
                  : 'mixed',
            pageCount: document.pages.length,
            elapsedMs: terminalDocumentProgress.elapsedMs,
          },
          this.threadId,
        );
        extractedTextParts.push(buildIngestedDocumentTextPart({ filename: file.filename, path: file.path }, document));
      } else {
        const issue = document.issue ?? 'Extraction produced no text';
        yield buildDocumentIngestionEvent(
          {
            fileName: file.filename,
            stagedPath: file.path,
            phase: 'failed',
            issue,
            elapsedMs: terminalDocumentProgress.elapsedMs,
          },
          this.threadId,
        );
        extractedTextParts.push(buildIngestionUnavailableNote({ filename: file.filename, path: file.path }, issue));
      }
    }

    // Append extracted text parts to context as a synthetic user message so the model sees them
    // before the LLM call. This message contains the extracted text from the staged documents.
    if (extractedTextParts.length > 0) {
      const contextMessage: ContextMessage = {
        role: 'user',
        content: extractedTextParts,
      };
      yield* this.appendToContext({
        context: [contextMessage],
        output: [],
        currentContextUsage: undefined,
        usage: undefined,
      });
    }
  }

  /**
   * Runs the pre-LLM context processors behind a no-progress watchdog. Each yielded
   * processor event resets the timer; a processor that stalls without yielding (and
   * without erroring) rejects with NoProgressTimeoutError instead of hanging the turn.
   * Callers convert that into a visible turn failure.
   */
  private async *executePreLLMProcessorsWithTimeout(
    signal: AbortSignal | undefined,
    options?: { forceCompaction?: boolean },
  ): AsyncGenerator<
    | ThreadOverwriteContextEvent
    | ContextCompactionEvent
    | AgentThreadAppendContext
    | { type: typeof InternalEventType.PASSTHROUGH; event: RegisteredPassthroughEvent }
    | InternalCapabilityStateEvent,
    void,
    unknown
  > {
    const timeoutMessage =
      `Pre-LLM context processors produced no output within ` +
      describeTimeout(this.preLLMProcessorsTimeoutMs);
    yield* drainWithNoProgressTimeout(
      this.executeContextProcessors('preLLM', signal, options),
      this.preLLMProcessorsTimeoutMs,
      timeoutMessage,
    );
  }

  private async *stepLLMCall(
    tools: ChatCompletionTool[],
    toolMapping: Map<string, MappedMCPTool>,
    signal: AbortSignal | undefined,
    options: StepLLMCallOptions,
  ): AsyncGenerator<AgentThreadEvent, StepLLMCallResult, unknown> {
    const { emptyTerminalFallback, retryModelMessageEventId } = options;
    const modelMessageEventId = retryModelMessageEventId ?? newEventId();
    if (signal?.aborted) {
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    // Captured before any preLLM context processor runs (see executeContextProcessors('preLLM')
    // below): ContextCompaction can rewrite `this.context` and drop the exact durable nudge
    // message this checks for, which would otherwise make an already-nudged turn look fresh again
    // after compaction and re-trigger the nudge (or, worse, drop straight into the host-note path
    // without ever having nudged). See hasSentEmptyAnswerNudgeThisTurn.
    const emptyAnswerNudgeAlreadySentThisTurn = hasSentEmptyAnswerNudgeThisTurn(this.context);

    const repositoryBeforeRefresh = this.sandbox?.getBoundRepositoryContext();
    // The pre-LLM processors run behind a no-progress watchdog: a processor that
    // stalls without yielding (and without erroring) must fail the turn visibly,
    // not hang it.
    // Whether a compaction pass already ran in this turn's normal pre-LLM
    // processing. Forcing a second full LLM compaction pass in the same turn
    // would re-summarize a fresh summary (diminishing returns, real information
    // loss, extra latency), so the pre-flight guards below skip their forced
    // pass when one already ran and fail clearly instead.
    let compactedThisTurn = false;
    try {
      for await (const event of this.executePreLLMProcessorsWithTimeout(signal)) {
        if (
          event.type === EventType.AGENT_CONTEXT_COMPACTION &&
          (event.outcome === 'applied' || event.outcome === 'truncated_fallback')
        ) {
          compactedThisTurn = true;
        }
        yield event;
      }
    } catch (error) {
      if (!(error instanceof NoProgressTimeoutError)) {
        throw error;
      }
      yield this.generateErrorEvent(
        `${error.message}, so the turn was stopped instead of hanging. ` +
          `A context processor stalled without producing output; try again, and if the ` +
          `problem persists, start a new chat.`,
        undefined,
        'fatal_error',
      );
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }
    if (signal?.aborted) {
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }
    const repositoryRefresh = this.sandbox?.refreshBoundRepositoryState({ signal });
    let refreshTimedOut = false;
    if (repositoryRefresh !== undefined) {
      // The sandbox refresh is an optimization for prompt accuracy, not critical
      // path: bound it, and on timeout continue with the pre-refresh state instead
      // of hanging the turn.
      const refreshOutcome = await awaitWithTimeout(
        awaitWithAbort({ operation: repositoryRefresh, signal }),
        this.sandboxRefreshTimeoutMs,
      );
      if (refreshOutcome === OPERATION_TIMEOUT) {
        refreshTimedOut = true;
        this.logger.warn('Sandbox repository refresh timed out; continuing with cached repository state', {
          timeoutMs: this.sandboxRefreshTimeoutMs,
        });
      }
    }
    if (signal?.aborted) {
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    const repositoryAfterRefresh = refreshTimedOut
      ? repositoryBeforeRefresh
      : this.sandbox?.getBoundRepositoryContext();
    if (
      repositoryBeforeRefresh?.branch !== repositoryAfterRefresh?.branch ||
      repositoryBeforeRefresh?.head_sha !== repositoryAfterRefresh?.head_sha
    ) {
      // Every model request atomically refreshes Sandbox Git state. Rebuild only
      // when that state changed, keeping ordinary prompt construction deterministic.
      this.instruction = this.buildInstruction(this.definition.instruction);
    }
    // Pre-flight guard: transformToLLMRequest is synchronous and assembles the whole
    // request before its safety ceiling is checked. If the raw context is already past
    // the ceiling, force one compaction pass; if it is still past the ceiling after
    // that, fail fast instead of blocking the event loop on a doomed assembly.
    if (estimateRawContextTextLength(this.context) > MAX_MODEL_REQUEST_CHARS) {
      // No double compaction in one turn: the normal pre-LLM pass above already
      // compacted, so a second forced pass would re-summarize a fresh summary.
      if (!compactedThisTurn) {
        for await (const event of this.executeContextProcessors('preLLM', signal, { forceCompaction: true })) {
          yield event;
        }
        if (signal?.aborted) {
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
      }
      const postCompactionLength = estimateRawContextTextLength(this.context);
      if (postCompactionLength > MAX_MODEL_REQUEST_CHARS) {
        throw new Error(
          `Context is ${postCompactionLength.toLocaleString('en-US')} characters, above the ` +
            `${MAX_MODEL_REQUEST_CHARS.toLocaleString('en-US')}-character safety ceiling even after ` +
            `compaction; refusing to assemble a request that would hang or fail in provider prefill. ` +
            `Start a new chat or reduce the context and try again.`,
        );
      }
    }

    // Token-based pre-flight guard: the character ceiling above does not account for
    // the model's token context limit. Estimate the full request in tokens
    // (instruction + definition messages + context + task state + tool definitions)
    // and force compaction if input tokens plus reserved output tokens would reach
    // the context length. The safety margin covers additive overhead on top of the
    // estimate (provider-added BOS token, template overhead, post-compaction
    // instruction/task-state messages); see TOKEN_BUDGET_SAFETY_MARGIN for its scope
    // and known limitations.
    const modelContextLength = this.definition.modelProperties?.contextLength;
    if (typeof modelContextLength === 'number' && Number.isFinite(modelContextLength) && modelContextLength > 0) {
      const maxOutputTokens = resolveMaxOutputTokens(this.definition.modelParams) ?? 0;
      const inputTokenBudget = modelContextLength - maxOutputTokens - TOKEN_BUDGET_SAFETY_MARGIN;
      const isOverLimit = (estimatedInputTokens: number): boolean =>
        estimatedInputTokens + maxOutputTokens + TOKEN_BUDGET_SAFETY_MARGIN >= modelContextLength;
      // The estimate bails out at the budget: precision past it cannot change the guard.
      const estimatedInputTokens = this.estimateFullRequestTokens(tools, inputTokenBudget);
      if (isOverLimit(estimatedInputTokens)) {
        // No double compaction in one turn: when the normal pre-LLM pass above
        // already compacted, skip the forced pass and fail clearly if the
        // estimate is still over, instead of re-summarizing a fresh summary.
        if (!compactedThisTurn) {
          for await (const event of this.executeContextProcessors('preLLM', signal, { forceCompaction: true })) {
            yield event;
          }
          if (signal?.aborted) {
            return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
          }
        }
        // Full-precision estimate for the error message: the early exit above
        // reports only a lower bound once past the budget.
        const postCompactionTokens = this.estimateFullRequestTokens(tools, Number.POSITIVE_INFINITY);
        if (isOverLimit(postCompactionTokens)) {
          throw new Error(
            `Estimated request is ${Math.ceil(postCompactionTokens).toLocaleString('en-US')} input tokens, above the ` +
              `${modelContextLength.toLocaleString('en-US')}-token context limit even after compaction; ` +
              `refusing to send a request the provider would reject. ` +
              `Start a new chat or reduce the context and try again.`,
          );
        }
      }
    }

    let requestBody = this.transformToLLMRequest(tools);
    if (signal?.aborted) {
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    // A cut or malformed model stream (ModelStreamFault, thrown by the ILLM client; see
    // VercelAILLM) is a model fault, not a host fault: it is retried, not treated as fatal. On
    // the first fault this attempts one retry, forcing context compaction first (the same
    // compaction path the ordinary preLLM threshold check uses, forced regardless of threshold;
    // see executeContextProcessors's forceCompaction option) so the retry runs under a shorter
    // context. A second fault in a row ends the turn with a specific, actionable error instead of
    // the generic fatal_error the outer catch in execute() would otherwise produce for it.
    const MAX_MODEL_STREAM_FAULT_ATTEMPTS = 2;
    let modelMessageUsage: ModelMessageUsage | undefined;
    let result: IteratorResult<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage>;
    for (let attempt = 1; ; attempt++) {
      const llmStream = this.definition.modelClient.create(requestBody);
      const requestLLMStreamClose = createAsyncIteratorCloseRequest(llmStream);

      // We start the delta stream with a model message event.
      yield {
        type: EventType.MODEL_MESSAGE,
        thread_id: this.threadId,
        created_at: new Date().toISOString(),
        id: modelMessageEventId,
      } satisfies ModelMessageEvent;

      let firstDeltaTimestamped = false;
      modelMessageUsage = undefined;
      try {
        // The first chunk waits behind the watchdog: a provider that accepts the request but
        // never produces output (and never errors) must fail the turn visibly, not hang it.
        let attemptResult = await nextModelChunkWithFirstResponseTimeout({
          iterator: llmStream,
          signal,
          requestClose: requestLLMStreamClose,
          timeoutMs: this.modelFirstResponseTimeoutMs,
        });
        if (attemptResult === MODEL_FIRST_RESPONSE_TIMEOUT) {
          yield this.generateErrorEvent(
            `The model produced no output within ${describeTimeout(this.modelFirstResponseTimeoutMs)}, so the ` +
              `turn was stopped instead of hanging. This usually means the request was too large for the ` +
              `model to start on, for example after pasting a very large document. Try a smaller message or ` +
              `a different model, then send again.`,
            undefined,
            'model_response_timeout',
          );
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
        if (attemptResult === ASYNC_ITERATOR_ABORTED) {
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
        while (!attemptResult.done) {
          const chunk = attemptResult.value;
          if (chunk.usage) {
            modelMessageUsage = this.computeAssistantMessageUsage({
              requestBody,
              usage: chunk.usage,
              toolMapping,
            });
          }
          const event = await buildModelMessageDeltaEvent({
            chunk,
            threadId: this.threadId,
            toolMapping,
            usage: modelMessageUsage,
            id: modelMessageEventId,
            logger: this.logger,
          });
          if (event) {
            if (!firstDeltaTimestamped) {
              firstDeltaTimestamped = true;
              yield { ...event, created_at: new Date().toISOString() };
            } else {
              yield event;
            }
          }
          attemptResult = await nextAbortableIteratorResult({
            iterator: llmStream,
            signal,
            requestClose: requestLLMStreamClose,
          });
          if (attemptResult === ASYNC_ITERATOR_ABORTED) {
            return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
          }
        }
        result = attemptResult;
        break;
      } catch (error) {
        // Cancellation and every non-stream-fault error keep their existing handling
        // (ASYNC_ITERATOR_ABORTED above for cancellation; execute()'s outer catch, fatal_error,
        // for anything else) rather than being retried here.
        if (signal?.aborted || !(error instanceof ModelStreamFault)) {
          throw error;
        }
        if (attempt >= MAX_MODEL_STREAM_FAULT_ATTEMPTS) {
          // A repetition fault carries its own actionable guidance; surfacing the
          // generic context-too-long text for it would mislead the user.
          const message =
            error instanceof ModelOutputRepetitionError
              ? error.message
              : "The model's output stream broke twice in a row, usually because the context is too long for it; start a new chat or use a different model";
          yield this.generateErrorEvent(message, undefined, 'model_stream_fault');
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
        this.logger.warn('Model stream fault; compacting context and retrying the call once', {
          ...extractErrorLogFields(error),
          attempt,
        });
        try {
          for await (const event of this.executePreLLMProcessorsWithTimeout(signal, { forceCompaction: true })) {
            yield event;
          }
        } catch (error) {
          if (!(error instanceof NoProgressTimeoutError)) {
            throw error;
          }
          yield this.generateErrorEvent(
            `${error.message}, so the turn was stopped instead of hanging. ` +
              `A context processor stalled without producing output; try again, and if the ` +
              `problem persists, start a new chat.`,
            undefined,
            'fatal_error',
          );
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
        if (signal?.aborted) {
          return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
        }
        requestBody = this.transformToLLMRequest(tools);
      }
    }

    // If the stream was aborted mid-way, result.value.output is only a partial
    // accumulation of the deltas — not the true complete response. Skip the
    // final model.message event to avoid emitting an inconsistent assembled message.
    if (signal?.aborted) {
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    // should be computed by this point but in case provider never gives out any delta with usage, compute it now.
    modelMessageUsage ??= this.computeAssistantMessageUsage({
      requestBody,
      usage: result.value.usage,
      toolMapping,
    });
    const assistantMessage: InternalEnrichedAssistantMessage = await enrichAssistantMessage({
      assistantMessage: result.value.output,
      toolMapping,
      // During context persistence, we have the complete message and hence the tool arguments are available.
      // Hence, we resolve the underlying tool to get the tool information.
      resolveUnderlyingTool: true,
      sentinel: this.sentinel,
    });
    const finishReason = result.value.finish_reason;
    // The empty-answer nudge (below) gets first say over a genuinely empty stop: only apply the
    // fixed host note on the second attempt, once that nudge already fired this turn and the
    // model is still silent.
    if (emptyAnswerNudgeAlreadySentThisTurn) {
      applyEmptyAnswerHostNote(assistantMessage, finishReason);
    }
    const shouldNudgeForEmptyReasoning =
      finishReason === 'stop' &&
      !emptyAnswerNudgeAlreadySentThisTurn &&
      !hasToolCalls(assistantMessage) &&
      !hasAssistantContent(assistantMessage) &&
      hasReasoningContent(assistantMessage);
    const emptyTerminalFailure =
      !shouldNudgeForEmptyReasoning &&
      finishReason === 'stop' &&
      emptyTerminalFallback !== undefined &&
      !hasToolCalls(assistantMessage) &&
      assistantMessageContentToStringForSubAgent(assistantMessage.content).trim().length === 0;
    const agentAssistantMessage = buildModelMessageEvent({
      // The terminal model event is authoritative. By this point the complete tool
      // arguments are available, so publish the same resolved, server-classified
      // tool metadata that admission uses. Streaming deltas may remain provisional.
      assistantMessage,
      threadId: this.threadId,
      finishReason,
      usage: modelMessageUsage,
      id: modelMessageEventId,
    });

    // A tool's admission class can depend on its complete arguments (for
    // example, `exec` distinguishes a read-only test command from commit or
    // push). The first streamed tool-call delta necessarily carries only
    // provisional metadata because its arguments are incomplete. Publish one
    // metadata-only delta after assembly so a live client reaches the same
    // authoritative state as a client that reloads the persisted event. Do not
    // repeat function arguments here: delta folders append those fragments.
    if (agentAssistantMessage.tool_calls?.length) {
      yield {
        type: EventType.MODEL_MESSAGE_DELTA,
        id: modelMessageEventId,
        thread_id: this.threadId,
        tool_calls: agentAssistantMessage.tool_calls.map((toolCall, index) => ({
          index,
          tool_info: toolCall.tool_info,
        })),
      } satisfies ModelMessageDeltaEvent;
    }

    // Reasoning-only empty answer: some OpenAI-compatible reasoning models (observed with Ollama
    // serving Qwen3) can spend an entire turn inside the thinking block and finish `stop` with
    // empty visible content. Ask for one more step instead of durably persisting a silent empty
    // message (or, for a sub-agent, a "done" completion carrying that empty content — a restart
    // between that append and the retry would replay the empty completion to the parent). Nothing
    // above this point is appended to context or emitted; only the nudge is, so the durable
    // history and the client see the retried answer, not the empty turn. At most once per turn
    // (hasSentEmptyAnswerNudgeThisTurn, checked against durable context so a thread reconstructed
    // mid-turn after a restart still honors it); the second answer is accepted whatever it is (an
    // empty second answer gets the fixed host note applied above, on the next call into this
    // method). The discarded call's usage is still real provider spend, so it is folded into
    // metrics here (usage: result.value.usage) even though its content and context message are
    // not persisted — see appendToContext, which updates metrics from `usage` independent of
    // `context`/`output` (the pattern ContextCompaction uses for a discarded compaction call).
    if (shouldNudgeForEmptyReasoning) {
      yield* this.appendToContext({
        context: [internalSystemMessage(EMPTY_ANSWER_NUDGE_MESSAGE)],
        output: [],
        currentContextUsage: undefined,
        usage: result.value.usage,
      });
      // See the grounding-nudge reset below for why currentState must be cleared here: this also
      // starts a new local request/response cycle within the same turn.
      this.currentState = null;
      // Reuse this call's id for the retry (see the retryModelMessageEventId parameter doc):
      // the discarded response's start/deltas already streamed live under it, and the retry's
      // start/deltas landing under the same id is what keeps a live client's view consistent
      // with what a reload reconstructs from durable output.
      return { outcome: 'continue', modelMessageEventId, retryModelMessageEventId: modelMessageEventId };
    }

    let completion: SubAgentCompletionMarker | undefined;
    if (this.parent) {
      if (finishReason === 'length') {
        const errorMessage = assistantMessageContentToStringForSubAgent(
          assistantMessage.content,
          'max_tokens breached',
        );
        completion = {
          type: 'error',
          output: agentAssistantMessage,
          error_message: errorMessage,
          send_to_parent: { role: 'tool', tool_call_id: this.parent.tool_call_id, content: errorMessage },
        };
      } else if (emptyTerminalFailure) {
        completion = {
          type: 'error',
          output: agentAssistantMessage,
          error_message: emptyTerminalFallback,
          send_to_parent: { role: 'tool', tool_call_id: this.parent.tool_call_id, content: emptyTerminalFallback },
        };
      } else if (!hasToolCalls(assistantMessage)) {
        const content = assistantMessageContentToStringForSubAgent(assistantMessage.content);
        completion = {
          type: 'done',
          output: agentAssistantMessage,
          send_to_parent: { role: 'tool', tool_call_id: this.parent.tool_call_id, content },
        };
      }
    }

    const completedWithinTokenBudget = finishReason !== 'length';
    yield* this.appendToContext({
      context: completedWithinTokenBudget ? [assistantMessage] : [],
      output: [agentAssistantMessage],
      currentContextUsage: completedWithinTokenBudget
        ? currentContextUsageFromCompletion(result.value.usage)
        : { prompt_tokens: result.value.usage.input_tokens, completion_tokens: 0 },
      usage: result.value.usage,
      completion,
    });

    if (finishReason === 'length') {
      const errorContent = completion?.error_message ?? 'max_tokens breached';
      yield this.generateErrorEvent(errorContent, agentAssistantMessage);
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    if (emptyTerminalFailure) {
      yield this.generateErrorEvent(emptyTerminalFallback, agentAssistantMessage);
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    if (!hasToolCalls(assistantMessage)) {
      // Host-enforced grounding check: a model cannot reliably self-identify
      // or state its own training cutoff (see the model-identity section
      // above), so a freshness question answered from memory alone, with no
      // retrieval tool called this turn even though one is attached, gets one
      // corrective step instead of being accepted outright. Root threads
      // only: a sub-agent's "user" message is the delegated task, not
      // something to second-guess this way. At most once per turn
      // (`groundingNudgeSentThisTurn`); the second answer is accepted
      // whatever it does.
      if (
        !this.parent &&
        finishReason === 'stop' &&
        !this.groundingNudgeSentThisTurn &&
        hasRetrievalTool(toolMapping.keys()) &&
        !hasCalledRetrievalTool(this.context) &&
        isFreshnessQuestion(lastUserMessageText(this.context) ?? '')
      ) {
        this.groundingNudgeSentThisTurn = true;
        yield* this.appendToContext({
          context: [internalSystemMessage(GROUNDING_NUDGE_MESSAGE)],
          output: [],
          currentContextUsage: undefined,
          usage: undefined,
          groundingNudge: true,
        });
        // The state machine normally reaches `llm-call-required` only from
        // null (turn start) or `tool-response-required`/`user-input-required`
        // (VALID_TRANSITIONS); appending a plain message and asking for
        // another LLM call re-derives `llm-call-required` from a context that
        // already ended in that state, which VALID_TRANSITIONS never allows
        // for ordinary steps. Reset here, the same way execute() does at the
        // start of a fresh call, since this genuinely starts a new local
        // request/response cycle within the same turn.
        this.currentState = null;
        return { outcome: 'continue', modelMessageEventId, retryModelMessageEventId: undefined };
      }
      yield {
        type: InternalEventType.AGENT_DONE,
        status: 'done',
        thread_id: this.threadId,
        title: this.title,
        output: agentAssistantMessage,
        parent: this.parent,
        send_to_parent: completion?.send_to_parent,
      };
      return { outcome: 'exit', modelMessageEventId, retryModelMessageEventId: undefined };
    }

    return { outcome: 'continue', modelMessageEventId, retryModelMessageEventId: undefined };
  }

  /**
   * Host-owned pre-dispatch admission for the tool-call budget. When the
   * model's batch emits more budgeted calls than remain, the excess is
   * marked `pre_dispatch_failure` so each resolves as a never_ran tool
   * result carrying a budget-exhausted message — deterministic, per-batch,
   * before any provider is reached. Only configured budgeted research tools
   * are subject to admission; control, approval, host, and unrelated tools
   * are always admitted. `record_finding` is always admitted (budget-exempt
   * bookkeeping). Returns the input array unchanged when the feature is off
   * or nothing is over budget.
   */
  private applyToolCallBudgetAdmission(calls: InternalEnrichedToolCall[]): InternalEnrichedToolCall[] {
    const budget = this.definition.toolCallBudget;
    if (budget === undefined) {
      return calls;
    }
    const admittedIds = admitToolCallsForBudget({
      state: this.taskState,
      budget,
      budgetedTools: this.definition.budgetedTools ?? [],
      calls: calls.map(call => ({ id: call.id, originalToolName: call.tool_info.original_tool_name })),
    });
    if (admittedIds.size === calls.length) {
      return calls;
    }
    return calls.map(call =>
      admittedIds.has(call.id)
        ? call
        : {
            ...call,
            tool_info: {
              ...call.tool_info,
              pre_dispatch_failure: {
                kind: 'pre_dispatch_failed' as const,
                message:
                  `Research tool-call budget exhausted (${String(this.taskState.tool_calls_used)} of ${String(budget)} used). ` +
                  'This call was not executed. Bank remaining findings with record_finding and write the final answer.',
              },
            },
          },
    );
  }

  private async *stepToolResponse(
    toolMapping: Map<string, MappedMCPTool>,
    unavailableToolsSeen: Set<string>,
    toolCallMemo: ToolCallMemoState,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentThreadEvent, StepOutcome, unknown> {
    const assistantMessage = lastAssistantInContext(this.context);
    if (!assistantMessage) {
      throw new Error('unreachable');
    }

    const openIds = getOpenToolCallIds(this.context);
    const openCalls = assistantMessage.tool_calls?.filter(tc => openIds.has(tc.id)) ?? [];
    const recordedDecisions = scanApprovalDecisions(this.context);
    const admissions = effectiveToolAdmissions({
      calls: openCalls,
      decisions: recordedDecisions,
      chatApprovalGrants: this.chatApprovalGrants,
      implementationPlanGrants: this.implementationPlanGrants,
    });
    const decisions = new Map<string, ApprovalDecision>();
    for (const [id, admission] of admissions) {
      if (admission.decision !== undefined) {
        decisions.set(id, admission.decision);
      }
    }
    const admissionProvenance = new Map([...admissions].map(([id, admission]) => [id, admission.admission_provenance]));
    const nextToolCallMemo = cloneToolCallMemoState(toolCallMemo);
    for (const call of openCalls) {
      if (decisions.get(call.id)?.status === 'deny') {
        nextToolCallMemo.deniedApprovalIdentities.add(approvalGrantKey(call.tool_info));
      }
    }

    const executionCalls = await enforceRegisteredCommandApprovalIdentity({ calls: openCalls, toolMapping });
    const assistantForExecution: InternalEnrichedAssistantMessage = {
      ...assistantMessage,
      tool_calls: executionCalls,
    };
    const preparedSideEffectCalls = prepareSideEffectToolCalls({
      assistantMessage: assistantForExecution,
      toolMapping,
      approvalDecisions: decisions,
      memoState: nextToolCallMemo,
    });

    const sideEffectingCalls = executionCalls.filter(toolCall => preparedSideEffectCalls.callIds.has(toolCall.id));
    if (sideEffectingCalls.length > 0) {
      const executionStartedEvents: ToolExecutionStartedEvent[] = sideEffectingCalls.map(toolCall => ({
        type: EventType.TOOL_EXECUTION_STARTED,
        id: newEventId(),
        thread_id: this.threadId,
        tool_call_id: toolCall.id,
        tool_name: toolCall.function.name,
        created_at: new Date().toISOString(),
        ...(toolCall.tool_info.command_execution === undefined
          ? {}
          : { command_execution: toolCall.tool_info.command_execution }),
      }));

      // Persist the replay marker and side-effect memo together before emitting the
      // client event or dispatching. Recovery therefore fails closed after any
      // interruption at or beyond this boundary. The event means "durably
      // admitted", not "dispatched": the two-phase scheduler may still be
      // running Phase-A reads when a side-effecting call is admitted, so
      // dispatch of an admitted call can lag its TOOL_EXECUTION_STARTED event.
      yield* this.appendToContext({
        context: [
          {
            type: 'internal.tool.execution_tracking',
            tool_call_ids: sideEffectingCalls.map(toolCall => toolCall.id),
          },
          ...executionStartedEvents,
        ],
        output: [],
        currentContextUsage: undefined,
        usage: undefined,
        toolCallMemo: nextToolCallMemo,
      });

      for (const executionStartedEvent of executionStartedEvents) {
        yield executionStartedEvent;
      }
    }

    // Each yielded start event has crossed the session store boundary before
    // the consumer requests another generator value. Cancellation can win at
    // that boundary (including the extended server deadline), so recheck here
    // and turn every durably started side effect into one never_ran result.
    // This is also the final admission seam for host grants that may be added
    // by integration tranches: any such grant must be refreshed here, before
    // executeToolCalls can reach a provider. The tool-call budget admission
    // runs first, so an over-budget batch is capped deterministically before
    // any provider is reached.
    const budgetAdmittedCalls = this.applyToolCallBudgetAdmission(executionCalls);
    const callsForDispatch = signal?.aborted
      ? budgetAdmittedCalls.map(call =>
          preparedSideEffectCalls.callIds.has(call.id)
            ? {
                ...call,
                tool_info: {
                  ...call.tool_info,
                  pre_dispatch_failure: {
                    kind: 'pre_dispatch_failed' as const,
                    message: 'The turn was cancelled after durable start and before provider dispatch.',
                  },
                },
              }
            : call,
        )
      : budgetAdmittedCalls;
    const assistantForDispatch: InternalEnrichedAssistantMessage = {
      ...assistantForExecution,
      tool_calls: callsForDispatch,
    };

    // Host-owned budget reservation: admitted budgeted calls are charged
    // against the budget BEFORE any provider is reached, and the reservation
    // is persisted via a context append before dispatch. A crash between
    // admission and dispatch therefore fails closed (the slots stay spent)
    // instead of silently granting extra calls on recovery. Calls that end
    // up not reaching a provider (memoized, never_ran, denied,
    // policy_blocked) are refunded after results return. Non-budgeted tools
    // and `record_finding` are never reserved. The append carries no context
    // messages — the stores patch the task-state checkpoint on empty appends.
    // Live state advances only after the append is yielded (durable-state
    // ordering: yield event, then mutate).
    const taskBudget = this.definition.toolCallBudget;
    const budgetedTools = this.definition.budgetedTools ?? [];
    let reservedBudgetCalls = 0;
    if (taskBudget !== undefined) {
      reservedBudgetCalls = callsForDispatch.filter(
        call =>
          call.tool_info.pre_dispatch_failure === undefined &&
          matchesBudgetedTool(call.tool_info.original_tool_name, budgetedTools),
      ).length;
      if (reservedBudgetCalls > 0) {
        const reservedState = cloneTaskState(this.taskState);
        reservedState.tool_calls_used += reservedBudgetCalls;
        syncTaskPhase(reservedState, taskBudget);
        yield* this.appendToContext({
          context: [],
          output: [],
          currentContextUsage: undefined,
          usage: undefined,
          taskState: reservedState,
        });
        this.taskState = reservedState;
      }
    }

    const unavailableToolNames = openCalls.map(call => call.function.name).filter(name => !toolMapping.has(name));
    const repeatedUnavailableToolNames = [
      ...new Set(unavailableToolNames.filter(name => unavailableToolsSeen.has(name))),
    ];
    const {
      toolCallResults: executedToolCallResults,
      initializationInfo,
      createThreadEvents,
      sandboxCreated,
      authRequirementInfo,
      approvalRequiredToolCalls,
      clientSideToolCalls,
      events: passthroughEvents,
    } = await executeToolCalls({
      assistantMessage: assistantForDispatch,
      toolMapping,
      threadId: this.threadId,
      approvalDecisions: decisions,
      admissionProvenance,
      memoState: nextToolCallMemo,
      preparedSideEffectCalls,
      signal,
      toolDispatchMaxConcurrency: this.toolDispatchMaxConcurrency,
      toolCallTimeoutMs: this.toolCallTimeoutMs,
      runCodeToolCallTimeoutMs: this.runCodeToolCallTimeoutMs,
      logger: this.logger,
      sentinel: toDispatchSentinelContext(this.sentinel),
    });
    const resultsById = new Map(executedToolCallResults.map(result => [result.message.tool_call_id, result]));
    const toolCallResults = openCalls.flatMap(call => {
      const result = resultsById.get(call.id);
      return result === undefined ? [] : [result];
    });
    // A tool step must never leave an open call without a result. The turn
    // state machine only allows tool-response-required → llm-call-required,
    // so an orphaned call (e.g. a response the executor dropped without
    // producing a tool message, like clientSideToolRequired reaching the
    // dispatch path) kills the whole turn with an "invalid state transition"
    // fatal instead of recovering. Synthesize a terminal error result for
    // every call the step did not resolve, using the same closeout outcomes
    // as OpenToolCallCloser: provably-unstarted reads may be retried, while
    // a call that may have run tells the model to establish its effect
    // before continuing. Sub-agent launches are excluded — their real result
    // arrives later via send(), and a synthetic one would duplicate it.
    const resolvedCallIds = new Set(toolCallResults.map(result => result.message.tool_call_id));
    const launchedCallIds = new Set(createThreadEvents.map(event => event.tool_call_id));
    const orphanedCalls = openCalls.filter(
      call => !resolvedCallIds.has(call.id) && !launchedCallIds.has(call.id),
    );
    if (orphanedCalls.length > 0) {
      this.logger.warn('Tool step left tool calls without a result; synthesizing terminal error results', {
        threadId: this.threadId,
        toolCallIds: orphanedCalls.map(call => call.id),
        toolNames: orphanedCalls.map(call => call.function.name),
      });
      const closeouts = getClosableOpenToolCallOutcomes(this.context);
      const completedAt = new Date().toISOString();
      for (const call of orphanedCalls) {
        // The canonical closer refuses to classify a batch containing a
        // client-side call; fall back to the conservative unknown outcome so
        // the model inspects state instead of repeating a possible side effect.
        const closeout: ClosableToolOutcome =
          closeouts.get(call.id) ?? unknownOutcomeCloseout({ source: 'automatic' });
        toolCallResults.push({
          message: { role: 'tool', tool_call_id: call.id, content: closeout.rawContent },
          rawContent: closeout.rawContent,
          toolCallInfo: call.tool_info,
          screen: undefined,
          info: toolMapping.get(call.function.name),
          failure: true,
          isStructuredContent: false,
          completedAt,
          memoized: false,
          repeatCount: 1,
          blockedPrivateFallback: false,
          repeatedSideEffect: false,
          verificationReceiptCandidate: undefined,
          disposition: closeout.disposition,
          remediation: closeout.remediation,
          admissionProvenance: closeout.admissionProvenance,
        });
      }
    }
    for (const result of toolCallResults) {
      const toolCall = openCalls.find(call => call.id === result.message.tool_call_id);
      if (toolCall && !toolMapping.has(toolCall.function.name)) {
        result.message.content = `Tool ${toolCall.function.name} is unavailable in this conversation. Do not call it again. Use only the tools provided in the request, or continue without a tool.`;
      }
    }
    void clientSideToolCalls;
    if (approvalRequiredToolCalls.length > 0) {
      throw new Error('Unreachable');
    }
    this.metrics.total_tool_calls += toolCallResults.length;
    this.metrics.total_sub_agents += createThreadEvents.length;
    // Host-owned research-budget accounting. The next task state is built as a
    // clone — the pre-dispatch reservation refunded, staged findings folded
    // in, dispatched calls charged, phase re-synced — and persisted via the
    // tool-results append below; the live state advances only after that
    // append is yielded (durable-state ordering: yield event, then mutate).
    // Only calls that actually dispatched consume budget: memoized replays
    // cost nothing and teach nothing new, and never-ran/denied/policy-blocked
    // calls never reached a provider. Only configured budgeted tools are
    // charged — control, approval, host, and unrelated tools are free — and
    // `record_finding` itself is exempt (see noteExecutedToolCalls): it is
    // local bookkeeping, and charging it would punish the model for using
    // the scratchpad.
    let nextTaskState: TaskState | undefined;
    if (taskBudget !== undefined) {
      nextTaskState = cloneTaskState(this.taskState);
      // Refund the pre-dispatch reservation; the charge below counts only
      // what actually reached a provider.
      nextTaskState.tool_calls_used -= reservedBudgetCalls;
      const stagedFindings = this.taskStateToolSet?.drainPendingFindings() ?? [];
      for (const finding of stagedFindings) {
        recordTaskFinding(nextTaskState, finding);
      }
      const executedOriginalNames: string[] = [];
      for (const result of toolCallResults) {
        if (result.memoized) {
          continue;
        }
        if (
          result.disposition === 'never_ran' ||
          result.disposition === 'denied' ||
          result.disposition === 'policy_blocked'
        ) {
          continue;
        }
        const call = openCalls.find(candidate => candidate.id === result.message.tool_call_id);
        if (call !== undefined) {
          executedOriginalNames.push(call.tool_info.original_tool_name);
        }
      }
      noteExecutedToolCalls(nextTaskState, executedOriginalNames, budgetedTools);
      syncTaskPhase(nextTaskState, taskBudget);
    }

    if (initializationInfo.length > 0) {
      yield buildMCPInitializeEvent(initializationInfo, this.threadId);
    }

    if (sandboxCreated) {
      yield buildSandboxCreatedEvent(sandboxCreated);
    }

    for (const event of passthroughEvents) {
      yield { type: InternalEventType.PASSTHROUGH, event };
    }

    const toolIdsBeforeProcessing = toolCallResults.map(t => t.message.tool_call_id);
    const toolResponseExecution: Readonly<AgentThreadExecutionContext> = {
      threadId: this.threadId,
      signal,
      sandbox: this.sandbox,
      currentContextUsage: this.currentContextUsage,
      context: this.context,
    };
    for (const processor of this.toolResponseProcessors) {
      const processorResult = await processor.process(toolCallResults, toolResponseExecution);
      if (processorResult.sandboxCreated) {
        yield buildSandboxCreatedEvent(processorResult.sandboxCreated);
      }
      for (const event of processorResult.events ?? []) {
        yield { type: InternalEventType.PASSTHROUGH, event };
      }
    }
    if (toolIdsBeforeProcessing.length !== toolCallResults.length) {
      throw Error('Some tool call processor has removed tool call.');
    }
    const toolIdsAfterProcessing = new Set(toolCallResults.map(t => t.message.tool_call_id));

    if (!toolIdsBeforeProcessing.every(id => toolIdsAfterProcessing.has(id))) {
      throw Error('Tool call IDs do not match after processing.');
    }

    if (!nextToolCallMemo.editObserved) {
      const taskProgressObserved = toolCallResults.some(result => {
        if (result.failure) {
          return false;
        }
        const call = openCalls.find(candidate => candidate.id === result.message.tool_call_id);
        return call !== undefined && toolCallIsTaskProgress(call);
      });
      if (taskProgressObserved) {
        nextToolCallMemo.editObserved = true;
      } else {
        const preEditBudgetCalls = toolCallResults.filter(result => {
          const call = openCalls.find(candidate => candidate.id === result.message.tool_call_id);
          return call !== undefined && toolCallConsumesPreEditBudget(call);
        });
        nextToolCallMemo.inspectionCallsBeforeEdit += preEditBudgetCalls.length;
        if (
          nextToolCallMemo.inspectionCallsBeforeEdit >= INSPECTION_WARNING_LIMIT &&
          !nextToolCallMemo.inspectionBudgetWarned
        ) {
          const lastInspection = [...toolCallResults]
            .reverse()
            .find(result =>
              openCalls.some(call => call.id === result.message.tool_call_id && toolCallConsumesPreEditBudget(call)),
            );
          if (lastInspection !== undefined) {
            lastInspection.message.content +=
              '\n\nInspection budget warning: broad discovery is exhausted. Use only targeted inspection needed to identify the edit site, then make the smallest focused edit, run verification, or ask one concise question.';
            nextToolCallMemo.inspectionBudgetWarned = true;
          }
        }
      }
    }

    // Mixed-batch guard (see identicalCallNudgeMessage / hasSentHostNoteThisTurn below): if any
    // call from the same assistant message is still open after this step, a user-role note
    // appended now would land between this step's tool results and that other call's later result
    // once it arrives, producing an assistant -> tool -> user -> tool sequence some providers
    // reject. Every guard below defers through the same durable pending list instead, flushed once
    // every call in the batch has a result — see send()'s flushPendingHostNotesIfBatchClosed, used
    // both by the approval/client-response continuation and by the synthetic tool result a
    // finished sub-agent's launch call receives. Only toolCallResults actually gained a context
    // tool-response this step: a sub-agent launch in createThreadEvents is counted further below
    // (comment at the identical-call loop) but its own result is not appended until the sub-agent
    // later finishes, so it must still count as open.
    const resolvedCallIdsThisStep = new Set(toolCallResults.map(result => result.message.tool_call_id));
    const batchStillOpenAfterThisStep = openCalls.some(call => !resolvedCallIdsThisStep.has(call.id));

    // Only classify as empty-inspection if the batch is complete (no unresolved calls from the
    // same batch). Mixed batches with unresolved calls cannot be classified: an unanswered
    // client-side or approval-required call might provide data, or a still-running sub-agent
    // might return results that make the batch non-empty. Deferring the classification until
    // the batch closes ensures the streak reflects all results.
    const emptyInspectionBatch =
      !batchStillOpenAfterThisStep &&
      toolCallResults.length > 0 &&
      toolCallResults.every(result => {
        const call = openCalls.find(candidate => candidate.id === result.message.tool_call_id);
        if (call?.tool_info.effect !== 'inspect' || result.failure) {
          return false;
        }
        try {
          const value = JSON.parse(result.message.content) as {
            success?: unknown;
            response?: { exitCode?: unknown; result?: unknown };
          };
          return (
            value.success === true &&
            value.response?.exitCode === 0 &&
            typeof value.response.result === 'string' &&
            value.response.result.trim().length === 0
          );
        } catch {
          return result.message.content.trim().length === 0;
        }
      });
    if (emptyInspectionBatch) {
      nextToolCallMemo.consecutiveEmptyInspectionBatches += 1;
    } else {
      nextToolCallMemo.consecutiveEmptyInspectionBatches = 0;
      nextToolCallMemo.emptyInspectionNudgeGeneration += 1;
    }

    // A batch where every call was blocked before dispatch (never_ran /
    // policy_blocked) is the model retrying differently-shaped arguments
    // against the same root cause (e.g. an unbound workspace) rather than
    // making progress. Distinct from emptyInspectionBatch above, which
    // requires an actually-dispatched read that came back empty.
    const noProgressBatch =
      toolCallResults.length > 0 &&
      toolCallResults.every(result => result.disposition === 'never_ran' || result.disposition === 'policy_blocked');
    if (noProgressBatch) {
      nextToolCallMemo.consecutiveNoProgressBatches += 1;
    } else {
      nextToolCallMemo.consecutiveNoProgressBatches = 0;
      nextToolCallMemo.noProgressNudgeGeneration += 1;
    }

    // The failure budget is the superset: a batch counts as failed when nothing
    // in it produced a usable result, whichever way each call failed. The two
    // narrower counters above reset each other (a call that ran and failed is
    // not "blocked before dispatch"), which let a model alternate failure kinds
    // indefinitely while a sandbox was down.
    const failedBatch =
      toolCallResults.length > 0 &&
      toolCallResults.every(result => result.failure || result.disposition !== 'executed_ok');
    if (failedBatch) {
      nextToolCallMemo.consecutiveFailedBatches += 1;
    } else {
      nextToolCallMemo.consecutiveFailedBatches = 0;
      nextToolCallMemo.failedBatchNudgeGeneration += 1;
    }

    // Only true policy denials feed the budget. Structured-edit precondition failures
    // and implementation-plan admission blocks share the policy_blocked disposition but
    // carry their own remediation reason codes (structured_edit_stale,
    // implementation_plan_admission_blocked) with their own recovery paths — counting
    // them here would misdiagnose a stale edit, where retrying after a fresh read is
    // correct, as "the tool is not allowed here".
    const policyBlockedThisStep = toolCallResults.filter(
      result => result.disposition === 'policy_blocked' && result.remediation?.reason_code === 'tool_policy_blocked',
    ).length;
    // Staged in nextToolCallMemo and committed by the post-yield memo assignment below,
    // so a failed persist cannot leave the guard ahead of the durable turn state. Living
    // in the memo also lets an approval continuation hydrate the standing count instead
    // of restarting at 0 mid-turn.
    const policyBlockedCalls = this.toolCallMemo.policyBlockedCallsThisTurn + policyBlockedThisStep;
    nextToolCallMemo.policyBlockedCallsThisTurn = policyBlockedCalls;
    const allPolicyBlocked =
      toolCallResults.length > 0 && toolCallResults.every(result => result.disposition === 'policy_blocked');

    // Every guard below nudges once before it stops the turn, through the same deferred,
    // batch-closing mechanism as the identical-call nudge. "Due" is re-derived from context
    // each time rather than latched at the threshold crossing, so a nudge lost to compaction
    // can be re-sent instead of silently dropped.
    const guardNoteCandidates: PendingHostNote[] = [];
    // When every call in this batch was rejected by the tool policy and the policy-block
    // guard has already nudged (or is about to stop the turn), the generic no-progress /
    // failed-batch notes would only repeat its more specific diagnosis.
    const policyGuardOwnsBatch = allPolicyBlocked && policyBlockedCalls >= POLICY_BLOCKED_NUDGE_AT;
    const queueGuardNoteIfDue = (
      kind: PendingHostNoteKind,
      count: number,
      nudgeAt: number,
      stopAt: number,
      generation: number,
      buildMessage: (count: number, generation: number) => string,
      suppress: boolean,
    ): void => {
      if (suppress || count < nudgeAt || count >= stopAt) {
        return;
      }
      const signature = String(generation);
      if (hasSentHostNoteThisTurn(this.context, kind, signature)) {
        return;
      }
      guardNoteCandidates.push({ kind, signature, tool_name: '', message: buildMessage(count, generation) });
    };
    queueGuardNoteIfDue(
      'empty_inspection',
      nextToolCallMemo.consecutiveEmptyInspectionBatches,
      EMPTY_INSPECTION_NUDGE_AT,
      EMPTY_INSPECTION_STOP_AT,
      nextToolCallMemo.emptyInspectionNudgeGeneration,
      emptyInspectionNudgeMessage,
      false,
    );
    queueGuardNoteIfDue(
      'no_progress',
      nextToolCallMemo.consecutiveNoProgressBatches,
      NO_PROGRESS_NUDGE_AT,
      NO_PROGRESS_STOP_AT,
      nextToolCallMemo.noProgressNudgeGeneration,
      noProgressNudgeMessage,
      policyGuardOwnsBatch,
    );
    // Suppressed only when this is a no-progress batch AND its note has already been sent:
    // consecutiveNoProgressBatches is a subset of consecutiveFailedBatches (see the comment
    // above), and if the narrower guard's note is already in context, sending the failed-batch
    // note would be redundant. But if the no-progress note hasn't been sent yet, the failed-batch
    // note must not be suppressed just because the current batch is blocked.
    const suppressFailedBatchNote =
      noProgressBatch &&
      hasSentHostNoteThisTurn(this.context, 'no_progress', String(nextToolCallMemo.noProgressNudgeGeneration));
    queueGuardNoteIfDue(
      'failed_batch',
      nextToolCallMemo.consecutiveFailedBatches,
      FAILED_BATCH_NUDGE_AT,
      FAILED_BATCH_STOP_AT,
      nextToolCallMemo.failedBatchNudgeGeneration,
      failedBatchNudgeMessage,
      suppressFailedBatchNote || policyGuardOwnsBatch,
    );
    // The policy-block guard owns batches that are entirely policy denials: once it has
    // nudged (or is about to stop the turn), the generic notes would only repeat its more
    // specific diagnosis. The marker generation is constant 0: the counter never resets
    // within a turn (at most one nudge per turn), and hasSentHostNoteThisTurn's backward
    // scan stops at the new user message, so an earlier turn's marker never suppresses a
    // later turn's nudge. Kept in sync with the '0' marker inside policyBlockedNudgeMessage.
    queueGuardNoteIfDue(
      'policy_blocked',
      policyBlockedCalls,
      POLICY_BLOCKED_NUDGE_AT,
      POLICY_BLOCKED_STOP_AT,
      0,
      count => policyBlockedNudgeMessage(count),
      false,
    );

    // The repeat budget: the same call made four times in one turn is a loop,
    // whatever came back in between. Memoized replays and repeated side effects
    // already stop tighter loops; this catches the ones they cannot see, such as
    // a write with changing content alternating with an identical failing run.
    // A sub-agent launch leaves toolCallResults for createThreadEvents once it
    // has run, so it is counted from there; either list holds a call at most once.
    // The second occurrence of a signature does not stop the turn: it gets one
    // host-authored nudge instead (IDENTICAL_CALL_NUDGE_AT), pointing the model at the
    // result already in context. Whether the nudge is due is re-derived from context each
    // time (hasSentHostNoteThisTurn) rather than latched on thisTurnCount === 2:
    // context compaction excludes internal system messages, so a nudge sent at count 2 can
    // be gone from context by count 3, and this lets it be re-sent rather than silently lost
    // for the rest of the run up to the stop at IDENTICAL_CALL_STOP_AT.
    const countedCallIds = [
      ...toolCallResults.map(result => result.message.tool_call_id),
      ...createThreadEvents.map(event => event.tool_call_id),
    ];
    let repeatedSignature: InternalEnrichedToolCall | undefined;
    // Keyed by the full call signature (tool plus canonical arguments), not just the tool name;
    // see PendingHostNote. Two argument variants of the same tool are tracked, and nudged,
    // independently.
    const callsToNudge: { call: InternalEnrichedToolCall; signature: string }[] = [];
    const nudgedSignaturesThisBatch = new Set<string>();
    for (const callId of countedCallIds) {
      const call = openCalls.find(candidate => candidate.id === callId);
      if (call === undefined) {
        continue;
      }
      const signature = toolCallSignature(call);
      // Durable count: kept for the persistence contract and any other consumer of the
      // snapshot, but not used for the stop/nudge decisions below (see callSignatureCountsThisTurn).
      nextToolCallMemo.callSignatures.set(signature, (nextToolCallMemo.callSignatures.get(signature) ?? 0) + 1);
      const thisTurnCount = (this.callSignatureCountsThisTurn.get(signature) ?? 0) + 1;
      this.callSignatureCountsThisTurn.set(signature, thisTurnCount);
      if (thisTurnCount >= IDENTICAL_CALL_STOP_AT && repeatedSignature === undefined) {
        repeatedSignature = call;
      } else if (
        thisTurnCount >= IDENTICAL_CALL_NUDGE_AT &&
        !nudgedSignaturesThisBatch.has(signature) &&
        !hasSentHostNoteThisTurn(this.context, 'identical_call', signature)
      ) {
        callsToNudge.push({ call, signature });
        nudgedSignaturesThisBatch.add(signature);
      }
    }

    // Every note decided this step (the identical-call nudges above, plus the guard-streak notes
    // built earlier) is either sent now, if this step closed the last open call of the batch, or
    // folded into the durable pending list to flush later — see the mixed-batch comment above.
    const pendingNotesByKey = new Map<string, PendingHostNote>(
      nextToolCallMemo.pendingHostNotes.map(entry => [`${entry.kind}:${entry.signature}`, entry]),
    );
    const identicalCallNotesToSend = batchStillOpenAfterThisStep ? [] : callsToNudge;
    const guardNotesToSendNow = batchStillOpenAfterThisStep ? [] : guardNoteCandidates;
    if (batchStillOpenAfterThisStep) {
      for (const { call, signature } of callsToNudge) {
        pendingNotesByKey.set(`identical_call:${signature}`, {
          kind: 'identical_call',
          signature,
          tool_name: call.function.name,
          message: identicalCallNudgeMessage(call.function.name, signature),
        });
      }
      for (const candidate of guardNoteCandidates) {
        pendingNotesByKey.set(`${candidate.kind}:${candidate.signature}`, candidate);
      }
    }
    nextToolCallMemo.pendingHostNotes = [...pendingNotesByKey.values()];

    const canonicalToolResults = toolCallResults.map(result => buildCanonicalToolCallResult(this.threadId, result));
    const agentToolMessages: ToolResponseEventV2[] = canonicalToolResults.map(result => result.event);
    for (const msg of agentToolMessages) {
      yield msg;
    }
    // tool.response is persisted by the session/response layer when yielded; only mutate context here.
    // Host notes (identical-call nudges plus guard-streak notes, see above) ride along in the same
    // append: no client-visible output event of their own, and the durable tool results above are
    // unchanged by them. Only notes for a batch that is fully resolved after this step are
    // included; the rest were folded into nextToolCallMemo.pendingHostNotes above.
    yield* this.appendToContext({
      context: [
        ...canonicalToolResults.map(result => result.model_message),
        ...identicalCallNotesToSend.map(({ call, signature }) =>
          internalSystemMessage(identicalCallNudgeMessage(call.function.name, signature)),
        ),
        ...guardNotesToSendNow.map(candidate => internalSystemMessage(candidate.message)),
      ],
      output: [],
      currentContextUsage: undefined,
      usage: undefined,
      toolCallMemo: nextToolCallMemo,
      taskState: nextTaskState,
    });
    for (const [index, result] of toolCallResults.entries()) {
      const candidate = result.verificationReceiptCandidate;
      const durableResult = canonicalToolResults[index]?.event;
      if (!result.failure && candidate !== undefined && durableResult !== undefined) {
        await this.sandbox?.activateVerificationReceipt(candidate, {
          event_id: durableResult.id,
          thread_id: durableResult.thread_id,
          tool_call_id: durableResult.tool_call_id,
        });
      }
    }
    // The memo is durable only after the context-append event above has been
    // accepted by the consumer, just like the context itself. Committing it here
    // also commits the staged policy-block count — the staged budget becomes live
    // only after the tool responses it counts have been persisted.
    this.toolCallMemo = nextToolCallMemo;
    // Same for task state: the next state (staged findings folded in, budget
    // charged, phase re-synced) was persisted by the append above; only now
    // does the live state advance to it.
    if (nextTaskState !== undefined) {
      this.taskState = nextTaskState;
    }
    // Three policy denials in one turn means the model is pushing against a fixed
    // permission wall; stop and make it explain the limitation instead of burning more
    // calls. Checked before the generic streak stops so the specific diagnosis wins.
    if (this.toolCallMemo.policyBlockedCallsThisTurn >= POLICY_BLOCKED_STOP_AT) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          "Your tool calls keep being blocked by this conversation's tool policy: the tools are not allowed here, and retrying them or trying variants cannot succeed. Write your final answer now: tell the user in plain language what you tried to do, what is not permitted in this conversation, what you were able to accomplish, and ask how they would like to proceed. Do not make any more tool calls — just answer.",
        errorMessage:
          'The model made three tool calls blocked by the conversation tool policy in this turn, ignoring the earlier host note about it, so the turn was stopped. Policy-blocked calls cannot succeed by retrying; the model must use allowed tools or explain the limitation to the user.',
      });
    }
    if (nextToolCallMemo.consecutiveEmptyInspectionBatches >= EMPTY_INSPECTION_STOP_AT) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'Your inspections keep returning no matches. Write your final answer now based on what you have found so far, stating clearly what was not found. Do not make any more tool calls — just answer.',
        errorMessage:
          'The model made five consecutive inspections that returned no matches, ignoring the earlier host note about it, so the turn was stopped. Do not keep rephrasing the same search; use the evidence already collected or change strategy.',
      });
    }
    if (nextToolCallMemo.consecutiveNoProgressBatches >= NO_PROGRESS_STOP_AT) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'Your tool calls keep getting blocked before they run. Write your final answer now: explain what you tried, what blocked it, and what you know so far. Do not make any more tool calls — just answer.',
        errorMessage:
          'The model made five consecutive tool calls that were blocked before they ran, ignoring the earlier host note about it, so the turn was stopped. Retrying differently-shaped arguments will not help; read the actual blocking error, fix its root cause, or ask the user.',
      });
    }
    if (nextToolCallMemo.consecutiveFailedBatches >= FAILED_BATCH_STOP_AT) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'Your tool calls keep failing. Write your final answer now: report what you tried, what failed, and what you have learned so far. Do not make any more tool calls — just answer.',
        errorMessage:
          'The model made five consecutive tool calls that all failed, ignoring the earlier host note about it, so the turn was stopped. Trying another variant will not help; the tool or environment is not working. Report what failed and what is already known.',
      });
    }
    // Hard cap, one stage past the INSPECTION_WARNING_LIMIT nudge above: that nudge fires once
    // and does not itself stop a long run of interleaved successes and failures, so without this
    // the agent-loop iteration limit was the only ceiling. inspectionCallsBeforeEdit already
    // stops growing the moment editObserved flips true (see the `if (!nextToolCallMemo.editObserved)`
    // block above), so a structured edit resets this guard the same way it resets the nudge.
    if (!nextToolCallMemo.editObserved && nextToolCallMemo.inspectionCallsBeforeEdit >= INSPECTION_STOP_LIMIT) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'You have made many inspections without making progress. Write your final answer now summarizing what you found. Do not make any more tool calls — just answer.',
        errorMessage:
          'The model ran 30 inspection commands in this request without making an edit, so the request was stopped. Say which file or symbol to change, or ask it to summarise what it found so far.',
      });
    }
    if (repeatedSignature !== undefined) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote: `You keep making the same ${repeatedSignature.function.name} call. Write your final answer now using what it already returned. Do not make any more tool calls — just answer.`,
        errorMessage: `The model made the same ${repeatedSignature.function.name} call four times in this request, ignoring the earlier host note about it, so the turn was stopped. Repeating it will not change the result; use what it returned, change approach, or ask the user.`,
      });
    }

    const repeatedReads = toolCallResults.filter(shouldStopAfterMemoizedReplay);
    const repeatedVerification = repeatedReads.some(result => result.replayKind === 'verification');
    const repeatedGithubFileRead = repeatedReads.some(
      result =>
        result.toolCallInfo !== undefined &&
        isGithubFileRead(result.toolCallInfo.mcp_server_name, result.toolCallInfo.original_tool_name),
    );
    // A repeated side effect whose outcome is genuinely unknown (an identical
    // retry blocked because the earlier attempt's result was never observed)
    // is an ordinary, model-actionable tool failure: the tool result already
    // tells the model to inspect state before continuing, so it is left to
    // flow through like any other failed call rather than ending the turn.
    // The other repeatedSideEffect causes (a dependent mutation that did not
    // complete as expected, or a missing durable execution marker) indicate a
    // broken precondition the model cannot reason its way past, so those
    // still stop the turn.
    const repeatedSideEffects = toolCallResults.filter(
      result => result.repeatedSideEffect && result.disposition !== 'outcome_unknown',
    );
    const blockedFallback = toolCallResults.some(result => result.blockedPrivateFallback);
    if (
      nextToolCallMemo.repeatedDeniedApproval ||
      repeatedReads.length > 0 ||
      repeatedSideEffects.length > 0 ||
      blockedFallback
    ) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'You are repeating actions without gaining new information. Write your final answer now based on everything you have gathered so far. Do not make any more tool calls — just answer.',
        errorMessage: selectRepeatedActionStopMessage({
          repeatedDeniedApproval: nextToolCallMemo.repeatedDeniedApproval,
          repeatedSideEffects: repeatedSideEffects.length > 0,
          blockedFallback,
          repeatedVerification,
          repeatedGithubFileRead,
        }),
      });
    }
    for (const name of unavailableToolNames) {
      unavailableToolsSeen.add(name);
    }

    if (repeatedUnavailableToolNames.length > 0) {
      return yield* this.recoverFromLoopOrExit({
        recoveryNote:
          'You keep calling tools that are not available. Write your final answer now without them, using what you already know. Do not make any more tool calls — just answer.',
        errorMessage: `The model repeated unavailable ${repeatedUnavailableToolNames.length === 1 ? 'tool' : 'tools'} ${repeatedUnavailableToolNames.join(', ')} after receiving a corrective result, so the turn was stopped.`,
      });
    }

    if (authRequirementInfo.length > 0) {
      yield buildMCPAuthRequiredEvent(authRequirementInfo, this.threadId);
      return 'exit';
    }

    for await (const event of this.executeContextProcessors('postToolCall', signal)) {
      yield event;
    }
    if (signal?.aborted) {
      return 'exit';
    }
    for (const event of createThreadEvents) {
      yield event;
    }
    if (createThreadEvents.length > 0) {
      return 'exit';
    }

    return 'continue';
  }

  private *stepUserInputRequired(modelMessageEventId: string): Generator<AgentThreadEvent, StepOutcome, unknown> {
    const pendingClientSideToolCalls = getPendingClientSideToolCalls(this.context);
    if (pendingClientSideToolCalls.length > 0) {
      const responseRequiredEvent: ToolResponseRequiredEvent = {
        type: EventType.TOOL_RESPONSE_REQUIRED,
        id: newEventId(),
        created_at: new Date().toISOString(),
        thread_id: this.threadId,
        tool_calls: pendingClientSideToolCalls.map(tc => ({ id: tc.id, source_event_id: modelMessageEventId })),
      };
      yield responseRequiredEvent;
    }

    const pendingApprovalToolCalls = getPendingApprovalToolCalls({
      context: this.context,
      chatApprovalGrants: this.chatApprovalGrants,
      implementationPlanGrants: this.implementationPlanGrants,
    });
    if (pendingApprovalToolCalls.length > 0) {
      const event: ToolApprovalRequiredEvent = {
        type: EventType.TOOL_APPROVAL_REQUIRED,
        id: newEventId(),
        created_at: new Date().toISOString(),
        thread_id: this.threadId,
        tool_calls: pendingApprovalToolCalls.map(({ id }) => ({ id, source_event_id: modelMessageEventId })),
      };
      yield event;
    }
    return 'exit';
  }

  private buildReplayEvent(c: SubAgentCompletionMarker): InternalThreadDoneEvent {
    const base = {
      type: InternalEventType.AGENT_DONE,
      thread_id: this.threadId,
      title: this.title,
      parent: this.parent,
      send_to_parent: c.send_to_parent,
    };
    return c.type === 'done'
      ? { ...base, status: 'done', output: c.output }
      : { ...base, status: 'error', error: c.error_message ?? 'Sub-agent errored', output: c.output };
  }

  public async *execute(options?: {
    signal?: AbortSignal | undefined;
  }): AsyncGenerator<AgentThreadEvent, void, unknown> {
    const signal = options?.signal;

    this.throwIfContextBusy();
    this.contextBusy = true;
    this.currentState = null;

    // there should always be this top level try-catch block because agent execution cant raise an error. it should yield an error event.
    try {
      if (this.preComputedCompletion) {
        yield this.buildReplayEvent(this.preComputedCompletion);
        return;
      }

      if (!this.preSendRanThisTurn) {
        for await (const event of this.executeContextProcessors('preSend', signal)) {
          if (signal?.aborted) {
            return;
          }
          yield event;
        }
        if (signal?.aborted) {
          return;
        }
      }
      if (signal?.aborted) {
        return;
      }
      this.preSendRanThisTurn = false;
      const { initializationInfo, authRequirementInfo } = await this.tracing.withInitSpan(() => this.init());

      if (initializationInfo.length > 0) {
        yield buildMCPInitializeEvent(initializationInfo, this.threadId);
      }

      if (authRequirementInfo.length > 0) {
        yield buildMCPAuthRequiredEvent(authRequirementInfo, this.threadId);
        return;
      }

      const iterationLimit = this.definition.iterationLimit ?? DEFAULT_ITERATION_LIMIT;
      // Starts empty; set only after stepLLMCall in this execute(). That is intentional:
      // user-input-required is only reachable here right after an LLM step that produced
      // pending approval/client-side tools (which sets currentModelMessageEventId first).
      // A resumed turn that is still awaiting user input never reaches this loop — orchestrator
      // send() / validateSendInput rejects empty or incomplete batches before execute runs.
      let currentModelMessageEventId = '';
      // Set only when the previous stepLLMCall ended in the empty-answer nudge, so the next call
      // reuses that id instead of a fresh one (see stepLLMCall's retryModelMessageEventId param).
      let pendingRetryModelMessageEventId: string | undefined;
      // Per execute() call: a new user turn gets one fresh correction, while an
      // unavailable tool repeated in this turn cannot consume the iteration budget.
      const unavailableToolsSeen = new Set<string>();
      for (;;) {
        // Re-read each iteration: the tool list is memoized and rebuilt only
        // after invalidation, so the next model call sees the current list.
        const { tools, toolMapping } = this.getConvertedTools();
        for (;;) {
          const sandboxCreatedEvent = this.pendingSandboxCreatedEvents.shift();
          if (sandboxCreatedEvent === undefined) {
            break;
          }
          yield sandboxCreatedEvent;
        }

        // Pre-model document extraction: if there are staged documents awaiting extraction,
        // extract them now before the first LLM call. This yields progress events live over
        // the turn stream, file by file, and appends each file's extracted text to context
        // before the model call. `extractStagedDocuments` owns the full abort contract itself
        // (cancelling remaining files and never leaving a `started` file without a terminal
        // event), so — unlike other steps in this loop — this does not also return early the
        // moment `signal` is aborted: doing so would cut the generator off mid-cancellation and
        // leave later files without their own `cancelled` event.
        if (this.stagedDocumentsToExtract.length > 0) {
          for await (const event of this.extractStagedDocuments(signal)) {
            yield event;
          }
          this.stagedDocumentsToExtract = [];
        }
        if (signal?.aborted) {
          return;
        }

        await this.refreshImplementationPlanGrants();
        const state = this.deriveState();
        let outcome: StepOutcome;
        switch (state) {
          case 'llm-call-required': {
            // Cancel only before network/side-effecting steps (LLM call, tool execution), never before 'user-input-required', so the required event is always emitted once the assistant message is committed.
            if (signal?.aborted) {
              return;
            }
            if (this.metrics.iterations >= iterationLimit) {
              yield this.generateErrorEvent(
                `You have reached iteration limit of ${String(iterationLimit)}, please request again`,
                undefined,
                'iteration_limit',
              );
              return;
            }
            this.metrics.iterations++;

            // Host-owned tool-call budget: once the turn's research budget is
            // spent, the host moves the task into the final-answer phase and
            // withholds the configured budgeted research tools from the model
            // request — the model cannot decide to keep researching.
            // `record_finding` stays available so the model can bank its last
            // facts before answering, and control, approval, host, and
            // unrelated tools stay available throughout. Phase transitions
            // happen only in the constructor (hydration), at pre-dispatch
            // reservation, and after tool-result charging, so reading the
            // phase here is exact. This is the structural answer to
            // non-convergent research loops: stopping is host-owned, not
            // model-owned.
            const taskBudget = this.definition.toolCallBudget;
            const finalAnswerPhase = taskBudget !== undefined && this.taskState.phase === 'final_answer';
            const budgetedTools = this.definition.budgetedTools ?? [];
            const requestTools = finalAnswerPhase
              ? tools.filter(
                  tool =>
                    tool.type !== 'function' ||
                    !matchesBudgetedTool(
                      toolMapping.get(tool.function.name)?.originalToolName ?? tool.function.name,
                      budgetedTools,
                    ),
                )
              : this.toolCallMemo.clarificationAnswered
                ? tools.filter(
                    tool =>
                      tool.type !== 'function' ||
                      toolMapping.get(tool.function.name)?.originalToolName !== ASK_USER_QUESTION_TOOL_NAME,
                  )
                : tools;
            const llmResult = yield* this.stepLLMCall(requestTools, toolMapping, signal, {
              emptyTerminalFallback: undefined,
              retryModelMessageEventId: pendingRetryModelMessageEventId,
            });
            outcome = llmResult.outcome;
            currentModelMessageEventId = llmResult.modelMessageEventId;
            pendingRetryModelMessageEventId = llmResult.retryModelMessageEventId;
            break;
          }
          case 'tool-response-required': {
            if (signal?.aborted) {
              return;
            }
            outcome = yield* this.stepToolResponse(toolMapping, unavailableToolsSeen, this.toolCallMemo, signal);
            break;
          }
          case 'user-input-required': {
            // Intentionally no cancellation check here — see comment in 'llm-call-required'.
            // source_event_id comes from currentModelMessageEventId; see comment where it is declared.
            outcome = yield* this.stepUserInputRequired(currentModelMessageEventId);
            break;
          }
          default: {
            throw new Error('unreachable');
          }
        }
        if (outcome === 'exit') {
          return;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      // Providers / transports often reject with plain objects; instanceof Error would
      // otherwise collapse those into an opaque "Unknown error occurred" in Agent Steps.
      this.logger.error('Agent thread execution failed', extractErrorLogFields(error));
      yield this.generateErrorEvent(describeUnknownError(error), undefined, 'fatal_error');
    } finally {
      this.contextBusy = false;
    }
  }
}

/**
 * Cheap text-length estimate over the raw context, without the full message
 * conversion that transformToLLMRequest performs. Used as a pre-flight guard so a
 * giant context compacts first (or fails fast) instead of blocking the event loop
 * inside the synchronous request assembly.
 */
/**
 * Text-only character length of one context message: string content as-is, and only
 * `text` parts of multipart content. Binary/base64 payloads in image_url,
 * input_audio, and file parts are deliberately skipped: the conservative
 * chars-per-token heuristic would inflate them wildly (a 1MB image reads as
 * ~340k tokens) while the provider does not bill those bytes as text tokens.
 */
function contextMessageTextLength(message: ContextMessage): number {
  if (!isLLMContextMessage(message)) {
    return 0;
  }
  const content: unknown = message.content;
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        total += (part as { text: string }).text.length;
      }
    }
    return total;
  }
  return 0;
}

/** Token estimate for one context message counting text only; see contextMessageTextLength. */
function contextMessageTextTokens(message: ContextMessage): number {
  return contextMessageTextLength(message) / ESTIMATE_CHARS_PER_TOKEN;
}

function estimateRawContextTextLength(context: readonly ContextMessage[]): number {
  let total = 0;
  for (const message of context) {
    total += contextMessageTextLength(message);
    // Early exit: precision past the ceiling buys nothing.
    if (total > MAX_MODEL_REQUEST_CHARS) {
      return total;
    }
  }
  return total;
}
function assertUniqueStateKeys(capabilities: readonly AgentCapability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const key = capability.state?.key;
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      throw new AgentHarnessError(
        'capability_state_error',
        `Duplicate capability state key '${key}' — each key may be claimed by at most one capability`,
      );
    }
    seen.add(key);
  }
}

function claimCapabilityState(
  capabilities: readonly AgentCapability[],
  input: CapabilityState | undefined,
  logger: Logger,
): CapabilityState {
  if (!input) {
    return {};
  }
  const claimedKeys = new Set(capabilities.map(c => c.state?.key).filter((k): k is string => typeof k === 'string'));
  const claimed: CapabilityState = {};
  for (const [key, value] of Object.entries(input)) {
    if (!claimedKeys.has(key)) {
      logger.warn(`Dropping unclaimed capability_state key '${key}' — no capability declares it`);
      continue;
    }
    claimed[key] = value;
  }
  return claimed;
}
