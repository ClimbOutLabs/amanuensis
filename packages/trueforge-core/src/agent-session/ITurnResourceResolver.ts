import type { Logger } from 'winston';
import type { AgentCapability } from '../core/capabilities/AgentCapability';
import type { CompactionModel } from '../core/capabilities/builtins/ContextCompaction';
import type { TaskChecklistAccess } from '../core/capabilities/builtins/TaskChecklist';
import type { ModelMessageEvent } from '../core/events/schema';
import type { SentinelHostContext } from '../core/permissions';
import type { WebSearchTurnState } from '../core/permissions/webSearch';
import type { AgentDefinition } from '../core/runtime/AgentDefinition';
import type { AgentInfo } from '../core/runtime/AgentThread.types';
import type { HostToolCallPolicy } from '../core/runtime/HostToolCallPolicy';
import type { BoundRepository, Sandbox, SandboxInfo } from '../core/sandbox/Sandbox';
import type { AgentTracing } from '../core/tracing/AgentTracing';
import type { TurnRecord } from './models/TurnRecord';
import type { AgentSpec } from './schemas/agentSpec';

/** Result of {@link ITurnResourceResolver.resolveAgentDefinition}. */
export interface ResolvedAgentDefinition {
  definition: AgentDefinition;
  extraCapabilities?: AgentCapability[] | undefined;
  /**
   * Compaction role override, resolved once per thread alongside `definition`
   * (spec.auxiliary_models.compaction, when set). Undefined means the
   * compaction capability inherits `definition.modelClient` /
   * `definition.modelParams` — the thread's own model — resolved at use in
   * builtinsFromSpec rather than copied here, so there is exactly one source
   * of truth for "no override" and changing the main model carries an
   * inheriting compaction role with it.
   */
  compactionModel?: CompactionModel | undefined;
}

/**
 * Per-run wiring contract consumed by SessionHandle.createTurn(). Implementations hold
 * per-request state (secrets, providers, caches) freely.
 */
export interface ITurnResourceResolver<TTurnCustom extends object = Record<string, never>> {
  /** The turn's search and private-read state, shared by every thread's host context so one thread's reads bind the others. */
  readonly webSearchTurn: WebSearchTurnState;
  /** Host-owned durable task state shared by the root thread's checklist and compaction. */
  readonly compactionContext?: TaskChecklistAccess | undefined;
  /**
   * Host instance-wide compaction trigger in tokens, used only when the agent spec sets no
   * `config.context_management.compaction.trigger`; an explicit spec value always wins.
   * Undefined leaves the threshold to the model's context length (see resolveCompactionThresholdTokens).
   */
  readonly compactionThresholdTokensDefault?: number | undefined;
  /**
   * Host instance-wide cap on concurrently dispatched read-only tool calls per
   * assistant batch (Phase A of the two-phase scheduler in executeToolCalls).
   * Undefined falls back to the core default (see
   * DEFAULT_TOOL_DISPATCH_MAX_CONCURRENCY).
   */
  readonly toolDispatchMaxConcurrency?: number | undefined;
  /**
   * Host instance-wide per-tool-call dispatch deadline in milliseconds: how
   * long a turn waits for one provider call before recording outcome_unknown.
   * Undefined falls back to the core default (see DEFAULT_TOOL_CALL_TIMEOUT_MS).
   */
  readonly toolCallTimeoutMs?: number | undefined;
  /**
   * sandbox/run_code's own dispatch deadline in milliseconds — the provisioning-sized
   * bound (image-pull + longest run + margin), scoped to that one tool.
   * Undefined falls back to the core default (see
   * DEFAULT_RUN_CODE_TOOL_CALL_TIMEOUT_MS).
   */
  readonly runCodeToolCallTimeoutMs?: number | undefined;
  /**
   * Host instance-wide bound in milliseconds on waiting for a model call's
   * first output before the turn fails visibly instead of hanging. Undefined
   * falls back to the core default (see DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS).
   */
  readonly modelFirstResponseTimeoutMs?: number | undefined;
  /**
   * Per-run host policy over tool calls, consulted synchronously during
   * assistant-message enrichment before any provider dispatch. A block resolves
   * the call as `policy_blocked` with the host message as the tool error.
   * Undefined disables the hook.
   */
  readonly toolCallPolicy?: HostToolCallPolicy | undefined;
  /** Host-resolved T2 repository binding, available even when the sandbox capability is disabled. */
  readonly boundRepository?: BoundRepository | undefined;
  /**
   * IANA timezone name the client sent with this turn (e.g. CreateTurnRequest.client_timezone),
   * forwarded to AgentDefinition.clientTimezone by resolveAgentDefinition. Undefined when the
   * client sent none; get_current_datetime and the ambient current-date section then fall back
   * to UTC.
   */
  readonly clientTimezone?: string | undefined;
  /** Forwarded to AgentThread / orchestrator / RemoteMCP. */
  readonly logger: Logger;
  /** Called exactly once per run, before any other method. */
  createTracing(): AgentTracing;
  /**
   * Look up the live AgentSpec for a named (ref) session agent.
   * Value sessions use the stored spec and never call this.
   */
  resolveAgentSpec(input: { agent_id: string }): Promise<AgentSpec>;
  /**
   * Called exactly once per run, before any thread is built; the harness holds
   * the result and shares the same reference across all threads. Return
   * undefined when the run needs no sandbox. `existing` carries the previous
   * turn's sandbox info for cross-turn reattach.
   */
  resolveSandbox(input: {
    spec: AgentSpec;
    existing?: SandboxInfo | undefined;
    previousTurn?: TurnRecord<TTurnCustom> | undefined;
    tenant_id: string;
    created_by: string;
    session_id: string;
    turn_id: string;
    signal: AbortSignal;
    tracing: AgentTracing;
    /** Session-scoped Sentinel context; sandbox approvals must use the session's services. */
    sentinel: SentinelHostContext;
  }): Promise<Sandbox | undefined>;
  /**
   * Called once per thread (rebuild or live sub-agent spawn); calls for different
   * threads may overlap, so implementations must be concurrency-safe.
   * `agent_info` is set for sub-agent threads. `previousTurn` is read-only:
   * branch on it, but never load state into capabilities — return blank
   * instances; the AgentThread constructor is the sole hydration path.
   * `extraCapabilities` are appended after the built-in capabilities.
   */
  resolveAgentDefinition(input: {
    spec: AgentSpec;
    agent_info?: AgentInfo | undefined;
    previousTurn?: TurnRecord<TTurnCustom> | undefined;
    signal: AbortSignal;
    tracing: AgentTracing;
    tenant_id: string;
    created_by: string;
    session_id: string;
    /**
     * Session-scoped Sentinel services, owned by SessionHandle. When provided,
     * the resolver uses these instead of minting its own, so tracked grants
     * and approval tokens are shared across threads in the session.
     */
    sentinel_services?: import('../core/permissions').SentinelServices | undefined;
    /** Workspace root for classifier boundary checks; null when none. */
    workspace_cwd?: string | null | undefined;
  }): Promise<ResolvedAgentDefinition>;
  /**
   * Release per-run resources. Called by the harness at the end of the run:
   * by TurnHandle.stream() in its finally (AFTER the terminal state write), or by
   * SessionHandle.createTurn() when it throws before a TurnHandle exists — so resources acquired
   * during a failed run (e.g. a sandbox VM) are still released. Best-effort:
   * the harness logs and swallows errors — close() can never flip a terminal
   * state or fail the turn. Must be idempotent. The resolver owns cleanup
   * because it owns acquisition: the run flow calls this one method without
   * knowing what was resolved.
   */
  close(): Promise<void>;
  /**
   * Optional host sanitizer for assistant text entering the durable thread
   * context. TurnHandle applies it to every assistant message in
   * AGENT_CONTEXT_APPEND before the store persists the context — so machine
   * markers the model echoed (e.g. knowledge-citation `⟦src:N⟧`) never become
   * live markers in the next turn's transcript, where they could
   * false-attribute a passage the new answer never used. Streamed deltas and
   * the turn's live in-memory context are untouched; only the durable copy
   * is sanitized. Undefined means no sanitization. A throwing hook keeps the
   * original text: sanitization can never fail the turn.
   */
  readonly sanitizeAssistantTextForContext?: ((text: string) => string) | undefined;
  /**
   * Optional host post-pass over the root thread's final assistant message.
   * Applied exactly once per turn, after execution completes and before the
   * terminal state is persisted and TURN_DONE is published. Return undefined
   * to keep the original message. The harness treats a throwing hook as a
   * no-op (logged) so host post-processing can never fail the turn. When the
   * hook changes the message, TurnHandle re-publishes the repaired
   * model.message event (same id) on the stream before TURN_DONE so
   * delta-folding live clients converge on the repaired content.
   *
   * Streamed deltas are deliberately not post-processed: stripping markers
   * mid-stream would need stateful cross-delta reassembly (a marker can
   * split across token-boundary deltas) for a transient artifact, and the
   * footer cannot be computed until the answer is complete anyway. Deltas
   * are non-durable transport; the repaired terminal event is what live
   * clients settle on.
   */
  readonly finalizeAssistantOutput?: ((output: ModelMessageEvent) => ModelMessageEvent | undefined) | undefined;
}
