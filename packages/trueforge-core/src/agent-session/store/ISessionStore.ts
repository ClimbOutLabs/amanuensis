import type { JsonValue } from '../../core/capabilities/AgentCapability';
import type {
  MCPServerInitInfo,
  ThreadOverwriteContextEvent,
  ToolExecutionStartedEvent,
  ToolResponseEventV2,
  ToolResultDisposition,
} from '../../core/events/schema';
import type { RegisteredCommandExecution } from '../../core/llm/LLMTypes';
import type { ToolCallMemoSnapshot } from '../../core/mcp/executeToolCalls';
import type { ImplementationPlanGrant, ImplementationPlanGrantOwner } from '../../core/mcp/implementationPlanGrant';
import type { ChatPrivateFingerprints } from '../../core/permissions/privateTextCheck';
import type {
  AgentThreadSnapshot,
  ContextMessage,
  SubAgentCompletionMarker,
} from '../../core/runtime/AgentThread.types';
import type { CurrentContextUsage } from '../../core/runtime/contextUsage';
import type { TaskStateSnapshot } from '../../core/runtime/taskState';
import type { SandboxInfo } from '../../core/sandbox/Sandbox';
import type { SessionFolderRecord } from '../models/SessionFolderRecord';
import type { SessionRecord } from '../models/SessionRecord';
import type { TurnRecord } from '../models/TurnRecord';
import type { PersistedTurnEvent, SessionEventItem, TurnDoneEvent } from '../schemas/events';
import type { TokenPagination } from '../schemas/pagination';
import type { SessionMetadata, SessionMetrics } from '../schemas/session';
import type { TaskChecklist, TaskChecklistItem } from '../schemas/taskChecklist';
import type { CancellationReason, TerminalTurnState } from '../schemas/turn';

/**
 * Caller-supplied fields for creating a session; the store owns timestamps and tip state.
 * `agent` is a discriminated reference | inline binding.
 */
export type CreateSessionInput<TSessionCustom extends object = Record<string, never>> = Pick<
  SessionRecord<TSessionCustom>,
  'tenant_id' | 'session_id' | 'agent' | 'created_by_subject' | 'external_id' | 'metadata' | 'source'
> & {
  custom: TSessionCustom | null;
};

export interface SetPrivateFingerprintsInput {
  session_id: string;
  fingerprints: ChatPrivateFingerprints;
}

/**
 * PATCH fields for an existing session; `undefined` fields are left unchanged.
 * `agent` may be set only on inline sessions, and only as an inline arm (`{ type: 'inline', spec }`).
 * `metadata` when set fully replaces the stored map (`{}` clears).
 */
export type UpdateSessionInput<TSessionCustom extends object = Record<string, never>> = Pick<
  SessionRecord<TSessionCustom>,
  'tenant_id' | 'session_id'
> & {
  agent: Extract<SessionRecord<TSessionCustom>['agent'], { type: 'inline' }> | undefined;
  title: SessionRecord<TSessionCustom>['title'] | undefined;
  metadata: SessionRecord<TSessionCustom>['metadata'] | undefined;
};

/** Archived timestamps and metrics for a session that data import has just replayed. */
export interface StampImportedSessionInput {
  tenant_id: string;
  session_id: string;
  created_at: Date;
  updated_at: Date;
  last_activity_timestamp_ms: number;
  metrics: SessionMetrics;
  /** One entry per replayed turn; each turn must already exist in the session. */
  turns: { turn_id: string; created_at: Date; updated_at: Date }[];
}

export interface GetSessionInput {
  tenant_id: string;
  session_id: string;
}

export interface GetOwnedIdsInput {
  tenant_id: string;
  ids: readonly string[];
  subject_id: string;
}

export interface GetSessionByExternalIdInput {
  tenant_id: string;
  external_id: string;
}

export interface DeleteSessionInput {
  tenant_id: string;
  session_id: string;
}

export interface ImplementationPlanTurnOwner extends ImplementationPlanGrantOwner {
  turn_id: string;
}

export type ListImplementationPlanGrantsInput = ImplementationPlanGrantOwner;

export interface PersistImplementationPlanGrantInput {
  grant: ImplementationPlanGrant;
  turn_id: string;
}

export interface RevokeImplementationPlanGrantInput extends ImplementationPlanGrantOwner {
  grant_id: string;
}

export type RevokeImplementationPlanGrantResult = { status: 'revoked' } | { status: 'absent' } | { status: 'pending' };

export interface BeginImplementationPlanDispatchInput extends ImplementationPlanTurnOwner {
  grant_id: string;
  checkout_id: string;
  dispatch_id: string;
}

export type BeginImplementationPlanDispatchResult = { status: 'admitted' } | { status: 'blocked' };

export interface CompleteImplementationPlanDispatchInput extends ImplementationPlanTurnOwner {
  grant_id: string;
  dispatch_id: string;
}

export interface GetTaskChecklistInput {
  tenant_id: string;
  session_id: string;
}

export interface ReplaceTaskChecklistInput extends GetTaskChecklistInput {
  expected_revision: number;
  items: TaskChecklistItem[];
}

export interface CreateSessionFolderInput {
  tenant_id: string;
  folder_id: string;
  created_by: string;
  name: string;
}

export interface GetSessionFolderInput {
  tenant_id: string;
  folder_id: string;
  created_by: string;
}

export interface ListSessionFoldersInput {
  tenant_id: string;
  created_by: string;
}

export interface UpdateSessionFolderInput {
  tenant_id: string;
  folder_id: string;
  created_by: string;
  name: string;
}

export interface DeleteSessionFolderInput {
  tenant_id: string;
  folder_id: string;
  created_by: string;
}

export interface SetSessionFolderInput {
  tenant_id: string;
  session_id: string;
  created_by: string;
  folder_id: string | null;
}

export interface ListSessionsInput {
  tenant_id: string;
  limit: number;
  page_token: string | undefined;
  order: 'asc' | 'desc' | undefined;
  /** Inclusive lower bound on `created_at` (instant). */
  start_timestamp: Date | undefined;
  /** Inclusive upper bound on `created_at` (instant). */
  end_timestamp: Date | undefined;
  /** When set, only sessions bound to this named agent id. */
  agent_id: string | undefined;
  /** When set, match creator or named-agent binding. Empty `agent_ids` means creator-only. */
  created_by_or_agent_ids:
    | {
        created_by_subject_id: string;
        agent_ids: readonly string[];
      }
    | undefined;
  /**
   * When set, only sessions whose metadata contains all key/value pairs
   * (exact string equality; extra session keys are allowed).
   * `undefined` means no metadata filter; `{}` matches only sessions with empty metadata.
   */
  metadata: SessionMetadata | undefined;
  /** When set, only sessions whose `source.type` matches. */
  source_type: string | undefined;
  /**
   * When set, only sessions whose `source.id` matches.
   * Requires `source_type`.
   */
  source_id: string | undefined;
}

/** Turn row fields without assembled snapshot (create input / listTurns). */
export type TurnRecordWithoutSnapshot<TTurnCustom extends object = Record<string, never>> = Omit<
  TurnRecord<TTurnCustom>,
  'snapshot'
>;

/** Thread registration; mutable per-turn data arrives through dedicated createTurn fields. */
export type NewThreadInit = Omit<
  AgentThreadSnapshot,
  'context' | 'current_context_usage' | 'completion' | 'capability_state'
>;

/** Complete canonical tool-call memo for one resulting thread. */
export type ThreadToolCallMemoInit = Pick<AgentThreadSnapshot, 'thread_id' | 'tool_call_memo'>;

/** Complete host-owned task-state scratchpad for one resulting thread. */
export type ThreadTaskStateInit = Pick<AgentThreadSnapshot, 'thread_id' | 'task_state'>;

/** Full post-send capability map for one thread. */
export type ThreadCapabilityStateInit = Pick<AgentThreadSnapshot, 'thread_id' | 'capability_state'>;

/** One drained send() append batch for one thread; writer = the new turn. */
export interface TurnContextAppend {
  thread_id: string;
  context: ContextMessage[];
  current_context_usage: CurrentContextUsage | null;
}

export interface CreateTurnInput<TTurnCustom extends object = Record<string, never>> {
  turn: TurnRecordWithoutSnapshot<TTurnCustom>;
  /** Sandbox identity resolved before thread construction, or null when this turn has none. */
  sandbox_info: SandboxInfo | null;
  /** Complete session-scoped approval grant set after applying this turn's decisions. */
  approval_grants: string[];
  /** Approval continuations must consume the current session tip exactly once. */
  require_previous_turn_is_tip: boolean;
  /**
   * Previous-turn threads that remain live in the new snapshot. The store
   * validates this as a subset of the actual predecessor and carries only
   * these rows forward; omitted terminal children remain in historical turns.
   */
  retained_previous_thread_ids: string[];
  /** Threads absent on the previous turn (turn 1: the root thread; else empty). */
  new_threads: NewThreadInit[];
  /**
   * All new messages, for new and carried-forward threads alike — collected by
   * draining orchestrator.send() BEFORE this call. Draining without persisting is
   * safe: send() mutates only in-memory threads, and if createTurn fails the whole
   * in-memory state (orchestrator, threads, resolver) is discarded — so either this
   * turn commits atomically with its appends, or nothing was persisted at all.
   */
  new_context_appends: TurnContextAppend[];
  /**
   * Complete post-send capability maps: exactly one entry per turn thread.
   * Authoritative for this turn; the store does not carry capability rows forward.
   */
  capability_states: ThreadCapabilityStateInit[];
  /** Complete canonical tool-call memos for all resulting threads. */
  tool_call_memos: ThreadToolCallMemoInit[];
  /** Complete host-owned task-state scratchpads for all resulting threads. */
  task_states: ThreadTaskStateInit[];
  /** Set only if session.title is NULL (first write wins). */
  update_session_title_if_not_exist: string | null;
}

export interface FreezeAndGetTurnInput {
  session_id: string;
  turn_id: string;
  /**
   * T5 compatibility field. When supplied, it must match the reason in the
   * cancelled event state. T7 callers may derive the reason from that state.
   */
  reason?: CancellationReason;
  /** Caller-built cancelled turn.done event with a handoff; its state is persisted atomically and verbatim. */
  turn_done_event: TurnDoneEvent;
}

export interface GetTurnInput {
  session_id: string;
  turn_id: string;
}

export interface ListTurnsInput {
  session_id: string;
  limit: number;
  page_token: string | undefined;
}

export interface UpdateTurnStateInput {
  session_id: string;
  turn_id: string;
  state: TerminalTurnState;
  /** Caller-built turn.done; written atomically with the state flip in the same tx. */
  turn_done_event: PersistedTurnEvent;
}

export interface AppendToEventsInput {
  session_id: string;
  turn_id: string;
  events: PersistedTurnEvent[];
}

export interface CommandExecutionRecord extends RegisteredCommandExecution {
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  tool_name: string;
  status: 'running' | 'terminal';
  disposition: ToolResultDisposition | null;
  owner_id: string;
  lease_id: string;
  lease_expires_at: Date;
  started_at: Date;
  completed_at: Date | null;
}

export interface AppendCommandExecutionStartedInput {
  session_id: string;
  turn_id: string;
  event: ToolExecutionStartedEvent & { command_execution: RegisteredCommandExecution };
  ownership: {
    owner_id: string;
    lease_id: string;
    lease_expires_at: Date;
  };
}

export interface AppendCommandExecutionResultInput {
  session_id: string;
  turn_id: string;
  event: ToolResponseEventV2;
  lease_id: string;
}

export interface RenewCommandExecutionLeaseInput {
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  lease_id: string;
  lease_expires_at: Date;
}

export interface GetCommandExecutionInput {
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
}

export interface RecoverRunningCommandExecutionsInput {
  completed_at: Date;
  owner_ids: readonly string[] | null;
  require_expired_lease: boolean;
}

export interface AddThreadsInput {
  session_id: string;
  turn_id: string;
  threads: AgentThreadSnapshot[];
}

/** Atomically records child snapshots with their corresponding thread-created events. */
export interface AddThreadsAndAppendEventsInput extends AddThreadsInput {
  events: PersistedTurnEvent[];
}

export interface RemoveThreadsInput {
  session_id: string;
  turn_id: string;
  thread_ids: string[];
}

export interface AppendToThreadContextInput {
  session_id: string;
  turn_id: string;
  thread_id: string;
  context: ContextMessage[];
  current_context_usage: CurrentContextUsage | null;
  completion: SubAgentCompletionMarker | null;
  tool_call_memo: ToolCallMemoSnapshot | undefined;
  /** Host-owned task-state snapshot; undefined leaves the persisted state untouched. */
  task_state: TaskStateSnapshot | undefined;
}

export interface OverwriteThreadContextInput {
  session_id: string;
  turn_id: string;
  event: ThreadOverwriteContextEvent;
}

export interface PatchMCPServersInput {
  session_id: string;
  turn_id: string;
  mcp_servers: MCPServerInitInfo[];
}

export interface PatchSandboxInfoInput {
  session_id: string;
  turn_id: string;
  sandbox_info: SandboxInfo;
}

export interface PatchThreadCapabilityStateInput {
  session_id: string;
  turn_id: string;
  thread_id: string;
  key: string;
  state: JsonValue;
}

export interface ListTurnEventsInput {
  session_id: string;
  turn_id: string;
  limit: number;
  page_token: string | undefined;
  order: 'asc' | 'desc' | undefined;
}

export interface ListSessionEventsInput {
  session_id: string;
  limit: number;
  page_token: string | undefined;
  last_turn_id: string | undefined;
  /** Event `type` values to keep; `undefined` keeps every type and an empty list keeps none. */
  types: readonly PersistedTurnEvent['type'][] | undefined;
  /** Exclusive lower bound on `event.id`, so a caller can fetch only events newer than one it has seen. */
  after_event_id: string | undefined;
}

/**
 * Session/turn persistence contract. Pure durability: no streaming, SSE, or
 * subscription members. Callers authorize the parent session before using
 * turn-scoped operations, which rely on globally unique session_id values.
 * Capability maps are initialized atomically by createTurn and subsequently
 * updated through patchThreadCapabilityState. Agent binding is session-scoped
 * as a discriminated `agent` (ref | value); named agents are not hydrated on read.
 */
export interface ISessionStore<
  TSessionCustom extends object = Record<string, never>,
  TTurnCustom extends object = Record<string, never>,
> {
  /**
   * Persists a discriminated `agent` (ref | value). SQL backends may flatten to columns.
   * `session_id` is globally unique across tenants.
   * Persists caller-supplied `created_by_subject` (immutable after create).
   * Sets `last_activity_timestamp_ms` (= now) on create.
   */
  createSession(input: CreateSessionInput<TSessionCustom>): Promise<void>;

  /**
   * Import-only. Overwrites the clock-stamped fields that createSession,
   * createTurn and the turn-state writes set to "now" (session and turn
   * `created_at` / `updated_at`, `last_activity_timestamp_ms`, `metrics`) with
   * the archived values, so a restored chat keeps its original dates and
   * totals. Bypasses the terminal-turn fence; nothing else calls it.
   * Missing session or turn rejects with the matching not-found error and
   * writes nothing.
   */
  stampImportedSession(input: StampImportedSessionInput): Promise<void>;

  /** Permanently removes a session and all related data; missing sessions are a no-op. */
  deleteSession(input: DeleteSessionInput): Promise<void>;

  /** Lists active grants for the owner-scoped session and its current repository binding, including between turns. */
  listImplementationPlanGrants(input: ListImplementationPlanGrantsInput): Promise<ImplementationPlanGrant[]>;

  /** Durably activates an integrity-checked grant from the owner-scoped current running turn. */
  persistImplementationPlanGrant(input: PersistImplementationPlanGrantInput): Promise<void>;

  /**
   * Owner-scoped revocation remains available between turns and linearizes when
   * the durable grant row is marked revoked. `revoked`
   * means no admitted dispatch can still begin; `pending` means an invocation had
   * already crossed the durable dispatch boundary and has not acknowledged a
   * terminal provider outcome yet. Both states block every future admission.
   */
  revokeImplementationPlanGrant(
    input: RevokeImplementationPlanGrantInput,
  ): Promise<RevokeImplementationPlanGrantResult>;

  /**
   * Atomically checks owner, current running turn, active grant, and checkout,
   * then inserts the turn-scoped unique dispatch reservation. The commit is
   * the dispatch linearization point; provider execution may begin only after
   * `admitted`.
   */
  beginImplementationPlanDispatch(
    input: BeginImplementationPlanDispatchInput,
  ): Promise<BeginImplementationPlanDispatchResult>;

  /** Durably acknowledges that a reserved requested provider invocation reached a terminal outcome. */
  completeImplementationPlanDispatch(input: CompleteImplementationPlanDispatchInput): Promise<void>;

  /**
   * Returns the session as stored (ref agents are not hydrated to a value).
   * Does **not** bump `last_activity_timestamp_ms` (read path).
   */
  getSession(input: GetSessionInput): Promise<SessionRecord<TSessionCustom> | undefined>;

  /** Returns the session-owned checklist or rejects when the tenant/session is absent. */
  getTaskChecklist(input: GetTaskChecklistInput): Promise<TaskChecklist>;

  /** Replaces the complete checklist atomically; the store owns the next revision. */
  replaceTaskChecklist(input: ReplaceTaskChecklistInput): Promise<TaskChecklist>;

  /**
   * Session ids among `ids` owned by `subject_id`. Empty `ids` → `[]`.
   * Does **not** bump `last_activity_timestamp_ms`.
   */
  getOwnedIds(input: GetOwnedIdsInput): Promise<readonly string[]>;

  /**
   * Lookup by tenant-scoped `external_id`. Missing or null external ids are not found.
   * Does **not** bump `last_activity_timestamp_ms` (read path).
   */
  getSessionByExternalId(input: GetSessionByExternalIdInput): Promise<SessionRecord<TSessionCustom> | undefined>;

  /**
   * PATCH semantics — update only the provided fields:
   * - agent: replace inline binding (inline sessions only; reference → invariant error).
   * - title: set/replace the session title.
   * - metadata: full replace of the caller-owned string map when set.
   * Bumps `last_activity_timestamp_ms` (= now) in the same update.
   */
  updateSession(input: UpdateSessionInput<TSessionCustom>): Promise<void>;

  /**
   * Merges a turn's private-text fingerprints into the chat's kept record, so a later turn of the chat can check its
   * searches. Entries are joined; once incomplete or holding a secret, the record stays so. A missing session is a
   * no-op. Deleted with the session.
   */
  setPrivateFingerprints(input: SetPrivateFingerprintsInput): Promise<void>;

  /** Creates an owner-scoped folder. The caller supplies its globally unique id. */
  createSessionFolder(input: CreateSessionFolderInput): Promise<SessionFolderRecord>;

  /** Returns a folder only when it belongs to the supplied owner. */
  getSessionFolder(input: GetSessionFolderInput): Promise<SessionFolderRecord | undefined>;

  /** Lists one owner's folders alphabetically. */
  listSessionFolders(input: ListSessionFoldersInput): Promise<SessionFolderRecord[]>;

  /** Renames an owner-scoped folder, returning undefined when it is absent or belongs to another owner. */
  updateSessionFolder(input: UpdateSessionFolderInput): Promise<SessionFolderRecord | undefined>;

  /** Deletes an owner-scoped folder. Assigned sessions become unassigned through the database FK. */
  deleteSessionFolder(input: DeleteSessionFolderInput): Promise<void>;

  /**
   * Assigns or unassigns one owner-scoped folder. The session and non-null folder
   * must both belong to `created_by`. This does not change either session activity timestamp.
   */
  setSessionFolder(input: SetSessionFolderInput): Promise<void>;

  /**
   * Paginated list of the tenant's sessions ordered by `updated_at`
   * (`order` defaults to `desc`, `session_id` tie-break). `page_token` is a
   * keyset cursor on `(updated_at, session_id)`. `start_timestamp` /
   * `end_timestamp` are inclusive instant bounds on `created_at`. Optional
   * `agent_id` filters ref-bound sessions. `created_by_or_agent_ids` matches
   * rows created by its subject OR bound to one of its agent ids; optional
   * `source_type` / `source_id` filter by JSON `source` (expression-indexed,
   * no scalar columns). Does **not** bump `last_activity_timestamp_ms` (read path).
   */
  listSessions(
    input: ListSessionsInput,
  ): Promise<{ data: SessionRecord<TSessionCustom>[]; pagination: TokenPagination }>;

  /**
   * Creates the turn AND advances `session.last_turn_id`. Context merging is the
   * store's responsibility: `new_context_appends` and `new_threads` are applied
   * on top of `retained_previous_thread_ids` from the previous turn's snapshot
   * when `turn.previous_turn_id` is set. Omitted predecessor threads remain in
   * history and are not revived in the new snapshot.
   * `capability_states` is the complete authoritative map for every resulting
   * thread and is persisted directly without store-side carry-forward.
   *
   * Atomicity (store contract): insert turn + set `last_turn_id` (+ session
   * turn-list append if the backend has one) MUST be one atomic unit per
   * session. Concurrent createTurn on the same session must not drop a turn
   * row or leave `last_turn_id` pointing at a turn that was never created.
   * The implementation supplies the mechanism (session lock, row lock/tx, …).
   *
   * Also bumps `session.last_activity_timestamp_ms` and increments
   * `session.metrics.total_turns` in that same atomic unit.
   *
   * Fork semantics for `turn.previous_turn_id`:
   * - `null` — new root turn (no parent); always allowed.
   * - string — fork/chain from that turn when it exists. Tip-equality is NOT
   *   required; concurrent forks from the same tip both succeed. Unknown id is
   *   allowed (relaxed) and treated as no inheritance. If that turn exists and
   *   is still `running`, reject with {@link PreviousTurnRunningError} —
   *   callers must {@link freezeAndGetTurn} first.
   * `last_turn_id` always advances to the new turn in the same atomic unit.
   *
   * `update_session_title_if_not_exist`: when set AND `session.title` is
   * unset/null, set it in the same atomic unit; an existing title is NEVER
   * overwritten (first write wins). The caller derives the value; the store
   * only conditionally sets it.
   */
  createTurn(input: CreateTurnInput<TTurnCustom>): Promise<void>;

  /**
   * One tx: (a) conditionally cancel a running turn with `reason`; (b) if it
   * did cancel, insert the caller-built `turn_done_event` and fold cost/duration
   * into `session.metrics` — already-terminal turns skip the event insert and
   * the metrics fold; (c) close any still-running registered command records as
   * `outcome_unknown`; (d) return the now-immutable turn record.
   * Missing turn → {@link TurnNotFoundError}.
   */
  freezeAndGetTurn(input: FreezeAndGetTurnInput): Promise<TurnRecord<TTurnCustom>>;

  /** Returns the turn record, or undefined if not found in this session. */
  getTurn(input: GetTurnInput): Promise<TurnRecord<TTurnCustom> | undefined>;

  /** Paginated list of turn rows (no snapshot); use getTurn for assembled snapshot. */
  listTurns(
    input: ListTurnsInput,
  ): Promise<{ data: TurnRecordWithoutSnapshot<TTurnCustom>[]; pagination: TokenPagination }>;

  /**
   * Writes the terminal state and `turn_done_event` atomically. Store contract —
   * **first terminal write wins**:
   * - Allowed: `running` → `done` | `cancelled` | `error`.
   * - Rejected with **409** (or equivalent conflict): any write when status is already
   *   terminal — including done→cancelled, cancelled→done, error→*, terminal→running.
   * - Missing turn → 404 / not-found.
   *
   * Check under the same concurrency control as other turn mutations (lock/CAS) —
   * not a racy read-then-write outside the critical section.
   * The same atomic unit closes any still-running registered command records for
   * this turn as `outcome_unknown`; a terminal turn never retains a running command.
   * The winning write also folds cost/duration into `session.metrics`.
   */
  updateTurnState(input: UpdateTurnStateInput): Promise<void>;

  /**
   * Durable event log for the turn. MUST include lifecycle rows: a
   * `TurnCreatedEvent` at the start of the stream and a terminal `TurnDoneEvent`
   * (or its cancelled/error shape) at the end. Every turn written through this
   * API persists lifecycle in the stream — implementations never synthesize
   * missing created/done rows on read. Every event MUST carry `id` and
   * `created_at`; `id` is a monotonic ULID and is the primary within-turn sort
   * key. `created_at` records event creation time but is not the order key.
   */
  appendToEvents(input: AppendToEventsInput): Promise<void>;

  /** Atomically writes the public start event and its durable registered-command record. */
  appendCommandExecutionStarted(input: AppendCommandExecutionStartedInput): Promise<void>;

  /** Atomically writes a terminal tool result and closes its durable registered-command record. */
  appendCommandExecutionResult(input: AppendCommandExecutionResultInput): Promise<void>;

  /** Extends only the matching running ownership lease; false means ownership was lost. */
  renewCommandExecutionLease(input: RenewCommandExecutionLeaseInput): Promise<boolean>;

  getCommandExecution(input: GetCommandExecutionInput): Promise<CommandExecutionRecord | undefined>;

  /** Distinct durable owners with a registered command still marked running. */
  listRunningCommandExecutionOwnerIds(): Promise<string[]>;

  /** Fails closed selected records left running by a prior process; providers cannot be reattached. */
  recoverRunningCommandExecutions(input: RecoverRunningCommandExecutionsInput): Promise<number>;

  /** Adds thread snapshots to the turn (sub-agent spawns). */
  addThreads(input: AddThreadsInput): Promise<void>;

  /** Atomically adds child snapshots and their durable thread-created events. */
  addThreadsAndAppendEvents(input: AddThreadsAndAppendEventsInput): Promise<void>;

  /** Removes threads from the turn by id. */
  removeThreads(input: RemoveThreadsInput): Promise<void>;

  /** Appends messages to a thread's context; optionally updates usage / completion marker. */
  appendToThreadContext(input: AppendToThreadContextInput): Promise<void>;

  /** Replaces a thread's context wholesale (context-overwrite event). */
  overwriteThreadContext(input: OverwriteThreadContextInput): Promise<void>;

  /** Patches the turn snapshot's MCP server init info (by source id). */
  patchMCPServers(input: PatchMCPServersInput): Promise<void>;

  /** Patches the turn snapshot's sandbox info (id for cross-turn reattach). */
  patchSandboxInfo(input: PatchSandboxInfoInput): Promise<void>;

  /** Generic capability KV — store has zero Plan/feature knowledge. */
  patchThreadCapabilityState(input: PatchThreadCapabilityStateInput): Promise<void>;

  /** Paginated read ordered lexically by monotonic `event.id` (asc default). */
  listTurnEvents(input: ListTurnEventsInput): Promise<{
    data: PersistedTurnEvent[];
    pagination: TokenPagination;
  }>;

  /**
   * Paginated session-wide feed of persisted events across turns, including
   * turn.created / turn.done lifecycle rows. Reads only — never synthesizes.
   *
   * Includes events from **running** turns (the HTTP layer may 409 separately;
   * that is not store semantics). Ordering: newest turn first, then monotonic
   * `event.id` descending within each turn. `last_turn_id` anchors the window
   * to that turn plus its ancestors; when omitted, the session's current
   * `last_turn_id` selects the active branch. Continuation page tokens are
   * keyset cursors that encode that anchor and take precedence over
   * `last_turn_id`, so later session activity cannot move an in-progress
   * pagination walk to another branch, nor repeat or skip rows on it.
   * `types` and `after_event_id` filter every page and are not encoded in the
   * token, so callers resend them with each continuation.
   * `ancestor_ids` may include only the previous N ancestors and need not reach
   * the root — implementations must spill through older turns' own
   * `ancestor_ids` when needed. Sibling branches from forks are excluded.
   */
  listSessionEvents(input: ListSessionEventsInput): Promise<{
    data: SessionEventItem[];
    pagination: TokenPagination;
  }>;
}
