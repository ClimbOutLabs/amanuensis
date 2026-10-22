/**
 * Bound session handle: starts turns via {@link SessionHandle.createTurn}.
 */
import { stripLegacyHostContextMessages } from '../core/capabilities/builtins/RepositoryBindingContext';
import type { ActionRequiredEvent, ApprovalDecision, UserToolApprovalMessage } from '../core/events/schema';
import { newEventId } from '../core/events/schema';
import type { RegisteredCommandExecution } from '../core/llm/LLMTypes';
import {
  isSerializedImplementationPlanGrant,
  serializeImplementationPlanGrant,
  type ImplementationPlanGrant,
} from '../core/mcp/implementationPlanGrant';
import {
  createSentinelHostContext,
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  forUnattendedRun,
  withoutRelaxations,
  type SentinelHostContext,
  type SentinelServices,
} from '../core/permissions';
import { isChangeRequestReason } from '../core/permissions/changeRequest';
import type { WebSearchTurnState } from '../core/permissions/webSearch';
import {
  mechanicalAbnormalHandoff,
  type AbnormalHandoff,
  type AbnormalHandoffCause,
  type HandoffRepositoryBinding,
} from '../core/runtime/AbnormalHandoff';
import type { AgentDefinition } from '../core/runtime/AgentDefinition';
import { AgentThread } from '../core/runtime/AgentThread';
import type {
  AgentThreadAppendContext,
  AgentThreadSendBatch,
  AgentThreadSnapshot,
} from '../core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../core/runtime/AgentThreadOrchestrator';
import {
  findUndecidedHeldToolCalls,
  isApprovalDecisionMessage,
  isClientSideToolResponseMessage,
  isInputUserMessage,
  scanApprovalDecisions,
} from '../core/runtime/contextUtils';
import type { CreateDynamicSubAgentThread } from '../core/runtime/CreateDynamicSubAgentThread';
import type { Sandbox } from '../core/sandbox/Sandbox';
import type { AgentTracing } from '../core/tracing/AgentTracing';
import { awaitWithAbort, throwIfSignalAborted } from '../core/util/abort';
import { threadCapabilities } from './builtinsFromSpec';
import type { ITurnResourceResolver, ResolvedAgentDefinition } from './ITurnResourceResolver';
import type { SessionRecord } from './models/SessionRecord';
import { MAIN_THREAD_ID, type TurnRecord } from './models/TurnRecord';
import type { AgentSpec } from './schemas/agentSpec';
import type { PersistedTurnEvent, SessionEventItem } from './schemas/events';
import { EventType, type TurnDoneEvent } from './schemas/events';
import type { TokenPagination } from './schemas/pagination';
import type { SessionAgent } from './schemas/session';
import type { TerminalTurnState, TurnInputItem } from './schemas/turn';
import { CancellationReason } from './schemas/turn';
import type {
  ISessionStore,
  NewThreadInit,
  ThreadTaskStateInit,
  ThreadToolCallMemoInit,
  TurnContextAppend,
  TurnRecordWithoutSnapshot,
} from './store/ISessionStore';
import { ApprovalRequestEndedError, TurnNotFoundError } from './store/SessionStoreErrors';
import { TurnHandle } from './TurnHandle';

/** How many recent ancestors SessionHandle persists on each turn. Store-local. */
const MAX_TURN_ANCESTORS = 20;

function resolvePreviousTurnId(requested: string | undefined, lastTurnId: string | null | undefined): string | null {
  if (requested === 'none') {
    return null;
  }
  if (requested === undefined || requested === 'auto') {
    return lastTurnId ?? null;
  }
  return requested;
}

function toSendBatch(input: TurnInputItem[] | undefined): AgentThreadSendBatch {
  if (!input || input.length === 0) {
    return [];
  }
  if (input.every(msg => isApprovalDecisionMessage(msg) || isClientSideToolResponseMessage(msg))) {
    return input;
  }
  if (input.every(isInputUserMessage)) {
    return input;
  }
  throw new Error('input must be homogeneous: all user messages, or all approval/tool-response messages');
}

function toNewThreadInit(snapshot: AgentThreadSnapshot): NewThreadInit {
  const { context, current_context_usage, completion, capability_state, ...rest } = snapshot;
  void context;
  void current_context_usage;
  void completion;
  void capability_state;
  return rest;
}

function collectContextAppends(
  events: AsyncGenerator<AgentThreadAppendContext, void, unknown>,
  signal?: AbortSignal,
): Promise<TurnContextAppend[]> {
  return (async () => {
    const appendMap = new Map<string, TurnContextAppend>();
    try {
      for await (const event of events) {
        const existing = appendMap.get(event.thread_id);
        if (existing) {
          existing.context.push(...event.context);
          if (event.current_context_usage !== undefined) {
            existing.current_context_usage = event.current_context_usage;
          }
        } else {
          appendMap.set(event.thread_id, {
            thread_id: event.thread_id,
            context: [...event.context],
            current_context_usage: event.current_context_usage ?? null,
          });
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        throw error;
      }
    }
    return [...appendMap.values()];
  })();
}

type CancelledTurnState = Extract<TerminalTurnState, { status: 'cancelled' }>;

export function abnormalHandoffCauseForCancellation(reason: CancellationReason): AbnormalHandoffCause {
  return reason === CancellationReason.ClientCancelled ? 'client_cancelled' : 'server_cancelled';
}

function repositoryBindingFromSession(
  record: Pick<SessionRecord, 'repository_id' | 'workspace_cwd'>,
): HandoffRepositoryBinding | undefined {
  if (record.repository_id === null || record.workspace_cwd === null) {
    return undefined;
  }
  return {
    repository_id: record.repository_id,
    revision: null,
    workspace_cwd: record.workspace_cwd,
  };
}

function cancelledTurnDoneEvent(state: CancelledTurnState): TurnDoneEvent {
  return {
    type: EventType.TURN_DONE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    state,
    thread_id: null,
  };
}

function threadsRecordFromMap(threads: Map<string, AgentThread>): Record<string, AgentThreadSnapshot> {
  const out: Record<string, AgentThreadSnapshot> = {};
  for (const [id, thread] of threads) {
    out[id] = thread.toSnapshot();
  }
  return out;
}

// Current-turn thread ids. Main (`MAIN_THREAD_ID`) is always present — first turn
// synthesizes it; later turns always carry it in the previous snapshot.
export function threadIdsForCurrentTurn(previous: ThreadSelectionTurn | undefined): string[] {
  if (previous?.state.status === 'running') {
    return Object.keys(previous.snapshot.threads);
  }
  if (previous?.state.status === 'done') {
    // A turn paused for approval ends as `done` with its pending actions. A sub-agent
    // that still owes one must be rebuilt, or its answer has no thread to reach. A child
    // in a terminal snapshot without a pending action never resumes (see below).
    const waiting = new Set(previous.state.required_actions.flatMap(action => action.thread_id ?? []));
    return [
      MAIN_THREAD_ID,
      ...Object.keys(previous.snapshot.threads).filter(id => id !== MAIN_THREAD_ID && waiting.has(id)),
    ];
  }
  // A child that still appears in a terminal snapshot never received a durable
  // THREAD_DONE/removal (for example another replica fenced its cleanup). A
  // later process may retain its snapshot for history, but must not resume it.
  return [MAIN_THREAD_ID];
}

/** The fields thread selection reads from a stored turn. */
export interface ThreadSelectionTurn {
  state:
    | { status: 'running' }
    | { status: 'done'; required_actions: readonly { thread_id: string | null }[] }
    | { status: 'cancelled' | 'error' };
  snapshot: { threads: Readonly<Record<string, unknown>> };
}

/**
 * What a resubmitted approval batch turns out to be.
 *
 * - `replay` — every decision was already recorded with the same effect; the turn is the
 *   one that recorded them, and the caller should return it rather than start another.
 * - `conflict` — a decision on record cannot be reconciled with the one submitted.
 * - `unrecorded` — at least one decision has no counterpart on record, so this is not a
 *   resubmission and whatever rejected it stands.
 */
export type ApprovalResubmission<TTurnCustom extends object> =
  | { outcome: 'replay'; turn: TurnRecord<TTurnCustom> }
  | { outcome: 'conflict'; tool_call_id: string }
  | { outcome: 'unrecorded' };

/**
 * Same decision, same effect. An omitted allow scope means `once`, so it matches an
 * explicit `once`; a widened or narrowed scope does not, because a grant already applied
 * cannot be revised after the fact. A deny's reason is free text shown to the agent and
 * does not change what was decided.
 */
function isSameApprovalDecision(recorded: ApprovalDecision, submitted: ApprovalDecision): boolean {
  if (recorded.status === 'allow') {
    return submitted.status === 'allow' && (recorded.scope ?? 'once') === (submitted.scope ?? 'once');
  }
  return submitted.status === 'deny';
}

/**
 * The turn as the chat shows it: cards cleared after their request ended are taken out of the
 * actions it still waits on. The stored turn is not changed.
 */
export function withoutClearedApprovals<TCustom extends object>(
  turn: TurnRecordWithoutSnapshot<TCustom>,
  cleared: ReadonlySet<string>,
): TurnRecordWithoutSnapshot<TCustom> {
  if (turn.state.status !== 'done' || cleared.size === 0) {
    return turn;
  }
  return {
    ...turn,
    state: { ...turn.state, required_actions: withoutClearedRequiredActions(turn.state.required_actions, cleared) },
  };
}

/** Required actions still waiting after the cleared cards are taken out. */
function withoutClearedRequiredActions(
  actions: readonly ActionRequiredEvent[],
  cleared: ReadonlySet<string>,
): ActionRequiredEvent[] {
  const remaining: ActionRequiredEvent[] = [];
  for (const action of actions) {
    if (action.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      remaining.push(action);
      continue;
    }
    const toolCalls = action.tool_calls.filter(toolCall => !cleared.has(approvalKey(action.thread_id, toolCall.id)));
    if (toolCalls.length > 0) {
      remaining.push({ ...action, tool_calls: toolCalls });
    }
  }
  return remaining;
}

/**
 * The same clearing for one persisted event, so a reloaded feed keeps cleared cards cleared. Returns
 * undefined when nothing in the event is left to show.
 */
export function withoutClearedApprovalEvent(
  event: PersistedTurnEvent,
  cleared: ReadonlySet<string>,
): PersistedTurnEvent | undefined {
  if (cleared.size === 0) {
    return event;
  }
  if (event.type === EventType.TOOL_APPROVAL_REQUIRED) {
    const toolCalls = event.tool_calls.filter(toolCall => !cleared.has(approvalKey(event.thread_id, toolCall.id)));
    return toolCalls.length > 0 ? { ...event, tool_calls: toolCalls } : undefined;
  }
  if (event.type === EventType.TURN_DONE && event.state.status === 'done') {
    return {
      ...event,
      state: { ...event.state, required_actions: withoutClearedRequiredActions(event.state.required_actions, cleared) },
    };
  }
  return event;
}

/** Turns read per page when looking for the request an approval answers. */
const APPROVAL_SCAN_PAGE_SIZE = 100;

/** Approval decisions are matched by the thread and the tool call they answer. */
function approvalKey(threadId: string, toolCallId: string): string {
  return `${threadId}\u0000${toolCallId}`;
}

/** Keys of the approvals a turn is still waiting on. Only a paused (`done`) turn can wait. */
function pendingApprovalKeysOf(turn: Pick<TurnRecord<object>, 'state'>): Set<string> {
  const keys = new Set<string>();
  if (turn.state.status !== 'done') {
    return keys;
  }
  for (const action of turn.state.required_actions) {
    if (action.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      continue;
    }
    for (const toolCall of action.tool_calls) {
      keys.add(approvalKey(action.thread_id, toolCall.id));
    }
  }
  return keys;
}

export class SessionHandle<
  TSessionCustom extends object = Record<string, never>,
  TTurnCustom extends object = Record<string, never>,
> {
  private readonly store: ISessionStore<TSessionCustom, TTurnCustom>;
  private session: SessionRecord<TSessionCustom>;
  /**
   * Session-scoped Sentinel services. Created once per SessionHandle so
   * tracked-executable grants and approval tokens are shared across the
   * main thread, sub-agent threads, and ToolSet batches within the session.
   * An unattended turn wraps them per turn and keeps the same stores.
   */
  private readonly sentinelServices: SentinelServices;

  constructor(options: {
    store: ISessionStore<TSessionCustom, TTurnCustom>;
    session: SessionRecord<TSessionCustom>;
    sentinelServices?: SentinelServices | undefined;
  }) {
    this.store = options.store;
    this.session = options.session;
    this.sentinelServices = options.sentinelServices ?? defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
  }

  get session_id(): string {
    return this.session.session_id;
  }

  /**
   * Creates the SentinelHostContext for this session. Session-scoped:
   * tenant_id, created_by, and conversation_id (mapped from session_id)
   * come from the authoritative session record. Services are the session's
   * shared instance so grants and tokens are visible across threads.
   */
  private createSentinelContext(services: SentinelServices, webSearch: WebSearchTurnState): SentinelHostContext {
    return createSentinelHostContext({
      services,
      tenant_id: this.session.tenant_id,
      created_by: this.session.created_by_subject.subject_id,
      conversation_id: this.session.session_id,
      workspace_cwd: this.session.workspace_cwd ?? null,
      web_search: webSearch,
    });
  }

  get tenant_id(): string {
    return this.session.tenant_id;
  }

  get agent(): SessionAgent {
    return this.session.agent;
  }

  get custom(): TSessionCustom | null {
    return this.session.custom;
  }

  get metadata(): SessionRecord<TSessionCustom>['metadata'] {
    return this.session.metadata;
  }

  get record(): SessionRecord<TSessionCustom> {
    return this.session;
  }

  /**
   * Prepares and commits a new turn — NO execution happens here (execution =
   * TurnHandle.stream()). Builds threads from the previous turn's snapshot, then
   * sends the input through the orchestrator fully drained (validation +
   * context append; empty input still preflights threads awaiting user input),
   * then persists via one atomic store.createTurn LAST. A send/validation
   * failure therefore persists nothing. The returned turn is durable with
   * state { status: 'running' }.
   *
   * On any failure, createTurn() closes the resolver (best-effort) before rethrowing,
   * so resources acquired here (e.g. a sandbox VM) never outlive a failed run.
   * On success, ownership of resolver.close() passes to TurnHandle.stream().
   *
   * `previous_turn_id`: omitted/`'auto'` → session tip; `'none'` → new root
   * (no parent, even on a non-empty session); string → fork from that turn
   * (must exist). Concurrent `'auto'` forks both succeed.
   */
  async createTurn(input: {
    turn_id: string;
    input?: TurnInputItem[] | undefined;
    /** 'auto'/omitted → session.last_turn_id; 'none' → new root; id → fork from that turn. */
    previous_turn_id?: string | undefined;
    signal: AbortSignal;
    resolver: ITurnResourceResolver<TTurnCustom>;
    /** Value = stored as-is. Fn = merge over previous turn's custom. Omitted = undefined. */
    custom?: TTurnCustom | ((previous?: TTurnCustom) => TTurnCustom) | undefined;
    /**
     * Forwarded to store.createTurn: sets session.title in the same atomic
     * unit IF the session has none; never overwrites. The caller derives the
     * value (e.g. from the first user message) — the library does not.
     */
    update_session_title_if_not_exist?: string | undefined;
    /** Called only after a registered command's durable start record commits. */
    on_command_execution_started?: ((execution: RegisteredCommandExecution) => void) | undefined;
    /** Durable owner written on registered-command leases (replica id in distributed mode). */
    command_execution_owner_id?: string | undefined;
    /**
     * No person watches this turn (a scheduled run): a call that would ask is held for the owner.
     * A follow-up turn in the same chat asks as usual, but never gets the owner's relaxations.
     */
    unattended?: boolean | undefined;
    /** End the turn after its tool step without calling the model. */
    stop_after_tool_response?: boolean | undefined;
  }): Promise<TurnHandle<TTurnCustom>> {
    // An ended request is never run. Clearing its card is the caller's job (dismissEndedApprovals).
    if (await this.answersOnlyEndedApprovals(input)) {
      throw new ApprovalRequestEndedError();
    }
    const previousTurnId = resolvePreviousTurnId(input.previous_turn_id, this.session.last_turn_id);
    // Read, do not freeze: cancelling here would make a submission that then fails
    // validation kill a running turn on its way out. The freeze happens below, once
    // nothing is left that can reject.
    const previous = previousTurnId ? await this.getTurnRecord(previousTurnId) : undefined;

    const custom = typeof input.custom === 'function' ? input.custom(previous?.custom ?? undefined) : input.custom;
    // A scheduled chat never gets the owner's relaxations, even on turns they type: its context still
    // holds what the run read. Only holding what would ask stays with the unattended turn itself.
    const sentinelServices =
      input.unattended === true
        ? forUnattendedRun(this.sentinelServices)
        : this.session.source?.type === 'schedule'
          ? withoutRelaxations(this.sentinelServices)
          : this.sentinelServices;

    // Dispose-on-early-failure: any resource acquired below (sandbox handle,
    // MCP connections) is owned by createTurn() until the TurnHandle is returned; from then
    // on TurnHandle.stream()'s finally owns resolver.close(). On any throw in this
    // acquisition phase we close the resolver (best-effort, error swallowed)
    // and rethrow — same pattern as the gateway's sessionTurnHandler, which
    // wraps getAgent/handler.init and calls gatewayStore.dispose() on failure.
    try {
      const tracing = input.resolver.createTracing();
      const agent = this.session.agent;
      const spec = agent.type === 'inline' ? agent.spec : await input.resolver.resolveAgentSpec({ agent_id: agent.id });
      const sandbox = await input.resolver.resolveSandbox({
        spec,
        existing: previous?.snapshot.sandbox_info ?? undefined,
        previousTurn: previous,
        tenant_id: this.session.tenant_id,
        created_by: this.session.created_by_subject.subject_id,
        session_id: this.session.session_id,
        turn_id: input.turn_id,
        signal: input.signal,
        tracing,
        sentinel: this.createSentinelContext(sentinelServices, input.resolver.webSearchTurn),
      });

      const definitionsByThreadId = await this.resolveAgentDefinitions({
        previous,
        resolver: input.resolver,
        spec,
        tracing,
        signal: input.signal,
        sentinelServices,
      });

      // Wire Code Mode once from main toolSets before threads share the sandbox.
      const mainDefinition = definitionsByThreadId.get(MAIN_THREAD_ID);
      if (!mainDefinition) {
        throw new Error('Unreachable: missing resolved agent definition for main thread');
      }
      if (sandbox) {
        sandbox.configureCodeMode(mainDefinition.definition.toolSets ?? []);
        // Code Mode must be configured before this refresh can initialize a
        // new sandbox, otherwise its client install is permanently omitted
        // from the run's cached initialization. The refreshed state is then
        // visible to every rebuilt thread through Sandbox.buildInstruction.
        await awaitWithAbort({
          operation: sandbox.refreshBoundRepositoryState({ signal: input.signal }),
          signal: input.signal,
        });
      }

      const planGrantOwner = {
        tenant_id: this.session.tenant_id,
        created_by: this.session.created_by_subject.subject_id,
        session_id: this.session.session_id,
      };
      const turnId = input.turn_id;
      const planGrantTurnOwner = { ...planGrantOwner, turn_id: turnId };
      let turnCommitted = false;
      const chatApprovalGrants = new Set(
        this.session.approval_grants.filter(value => !isSerializedImplementationPlanGrant(value)),
      );
      const loadImplementationPlanGrants = async (): Promise<ReadonlySet<string>> => {
        // send() validates and snapshots before createTurn commits. There is no
        // executable tool batch at that point, and the durable lifecycle must not
        // pretend the new turn already exists. execute() refreshes again after commit.
        if (!turnCommitted) {
          return new Set();
        }
        const durable = await this.store.listImplementationPlanGrants(planGrantOwner);
        const current = await sandbox?.implementationPlanGrantsForCurrentCheckout(durable);
        return new Set((current ?? []).map(serializeImplementationPlanGrant));
      };
      sandbox?.setImplementationPlanGrantContext({
        ...planGrantTurnOwner,
        persistGrant: grant => this.store.persistImplementationPlanGrant({ grant, turn_id: turnId }),
        loadGrant: async (grantId: string): Promise<ImplementationPlanGrant | undefined> => {
          const active = await this.store.listImplementationPlanGrants(planGrantOwner);
          return active.find(grant => grant.grant_id === grantId);
        },
        beginDispatch: input => this.store.beginImplementationPlanDispatch({ ...planGrantTurnOwner, ...input }),
        completeDispatch: input => this.store.completeImplementationPlanDispatch({ ...planGrantTurnOwner, ...input }),
      });

      // Computed before buildThreads: a batch with no new user message is an
      // approval/tool-response resubmission continuing the same in-flight
      // request, so the identical-call guard's this-request count must carry
      // forward into the fresh AgentThread instances built for it below.
      const sendBatch = toSendBatch(input.input);
      const isRequestContinuation = sendBatch.length > 0 && !sendBatch.some(isInputUserMessage);

      const agentThreads = this.buildThreads({
        previous,
        resolver: input.resolver,
        spec,
        sandbox,
        tracing,
        definitionsByThreadId,
        chatApprovalGrants,
        loadImplementationPlanGrants,
        isRequestContinuation,
        sentinelServices,
        stopAfterToolResponse: input.stop_after_tool_response === true,
      });

      const createDynamicSubAgentThread = this.makeCreateDynamicSubAgentThread({
        resolver: input.resolver,
        previous,
        spec,
        sandbox,
        tracing,
        chatApprovalGrants,
        loadImplementationPlanGrants,
        sentinelServices,
      });

      const orchestrator = new AgentThreadOrchestrator({
        agentThreads,
        createDynamicSubAgentThread,
        tracing,
        logger: input.resolver.logger,
      });

      // SEND BEFORE COMMIT — validate + append; throw ⇒ nothing persisted.
      const new_context_appends = await collectContextAppends(orchestrator.send(sendBatch, input.signal), input.signal);

      const approvalGrants = [...chatApprovalGrants];

      const now = new Date();

      const new_threads: NewThreadInit[] = [];
      if (!previous) {
        const root = agentThreads.get(MAIN_THREAD_ID);
        if (root) {
          new_threads.push(toNewThreadInit(root.toSnapshot()));
        }
      } else {
        for (const [threadId, thread] of agentThreads) {
          if (previous.snapshot.threads[threadId] === undefined) {
            new_threads.push(toNewThreadInit(thread.toSnapshot()));
          }
        }
      }

      const turnInit: TurnRecordWithoutSnapshot<TTurnCustom> = {
        turn_id: turnId,
        session_id: this.session.session_id,
        first_turn_id: previous?.first_turn_id ?? turnId,
        ancestor_ids: previous ? [...previous.ancestor_ids, previous.turn_id].slice(-MAX_TURN_ANCESTORS) : [],
        previous_turn_id: previousTurnId,
        state: { status: 'running' },
        input: input.input ?? [],
        created_at: now,
        updated_at: now,
        custom: custom ?? null,
      };

      const turnRecord: TurnRecord<TTurnCustom> = {
        ...turnInit,
        snapshot: {
          threads: threadsRecordFromMap(agentThreads),
          mcp_servers: previous?.snapshot.mcp_servers ?? null,
          sandbox_info: sandbox?.getCurrentSandboxInfo() ?? previous?.snapshot.sandbox_info ?? null,
        },
      };

      // Last point of no return. Everything that could reject this submission has run,
      // so cancelling the predecessor is now a consequence of a turn that is definitely
      // being created. store.createTurn's PreviousTurnRunningError backstops a race here.
      if (previousTurnId !== null) {
        await this.freezeTurn({
          turn_id: previousTurnId,
          reason: CancellationReason.CancelledForNextTurn,
        });
      }

      await this.store.createTurn({
        turn: turnInit,
        sandbox_info: sandbox?.getCurrentSandboxInfo() ?? previous?.snapshot.sandbox_info ?? null,
        approval_grants: approvalGrants.sort(),
        require_previous_turn_is_tip: (input.input ?? []).some(isApprovalDecisionMessage),
        retained_previous_thread_ids: previous ? threadIdsForCurrentTurn(previous) : [],
        new_threads,
        new_context_appends,
        capability_states: [...agentThreads].map(([thread_id, thread]) => ({
          thread_id,
          capability_state: thread.toSnapshot().capability_state,
        })),
        tool_call_memos: [...agentThreads].map(([thread_id, thread]): ThreadToolCallMemoInit => ({
          thread_id,
          tool_call_memo: thread.toSnapshot().tool_call_memo,
        })),
        task_states: [...agentThreads].map(([thread_id, thread]): ThreadTaskStateInit => ({
          thread_id,
          task_state: thread.toSnapshot().task_state,
        })),
        update_session_title_if_not_exist: input.update_session_title_if_not_exist ?? null,
      });
      turnCommitted = true;

      const refreshed = await this.store.getSession({
        tenant_id: this.tenant_id,
        session_id: this.session.session_id,
      });
      if (refreshed) {
        this.session = refreshed;
      }

      // The caller owns its signal. Give the stream a linked controller so a
      // consumer that stops iterating can run durable cancellation cleanup
      // without mutating the caller-visible AbortSignal.
      const turnAbortController = new AbortController();
      let callerAbortAttached = false;
      const forwardCallerAbort = (): void => {
        turnAbortController.abort(input.signal.reason);
      };
      if (input.signal.aborted) {
        forwardCallerAbort();
      } else {
        input.signal.addEventListener('abort', forwardCallerAbort, { once: true });
        callerAbortAttached = true;
      }
      const detachCallerAbort = (): void => {
        if (!callerAbortAttached) {
          return;
        }
        input.signal.removeEventListener('abort', forwardCallerAbort);
        callerAbortAttached = false;
      };
      const abortTurn = (reason: CancellationReason): void => {
        detachCallerAbort();
        if (!turnAbortController.signal.aborted) {
          turnAbortController.abort(reason);
        }
      };

      return new TurnHandle({
        store: this.store,
        turn: turnRecord,
        orchestrator,
        resolver: input.resolver,
        signal: turnAbortController.signal,
        abort: abortTurn,
        detachSignal: detachCallerAbort,
        onCommandExecutionStarted: input.on_command_execution_started,
        commandExecutionOwnerId: input.command_execution_owner_id,
      });
    } catch (error) {
      await input.resolver.close().catch((closeError: unknown) => {
        input.resolver.logger.warn('TurnResourceResolver.close() failed after createTurn() error', {
          err: closeError,
        });
      });
      throw error;
    }
  }

  /**
   * True when every item answers a request that already ended: the session issued it on an earlier
   * turn, and neither the turn the caller names nor the session tip still waits on it. An ended
   * request can be cleared but never run. A request this session never issued is not ended, so it
   * keeps its refusal.
   */
  async answersOnlyEndedApprovals(input: {
    previous_turn_id?: string | undefined;
    input?: readonly TurnInputItem[] | undefined;
  }): Promise<boolean> {
    const items = input.input ?? [];
    const previousTurnId = resolvePreviousTurnId(input.previous_turn_id, this.session.last_turn_id);
    if (items.length === 0 || previousTurnId === null || !items.every(isApprovalDecisionMessage)) {
      return false;
    }
    const wanted = new Set(items.map(item => approvalKey(item.thread_id, item.tool_call_id)));
    // Naming an older turn must not clear a card the tip still waits on.
    const tipTurnId = this.session.last_turn_id;
    for (const turnId of new Set(tipTurnId === null ? [previousTurnId] : [previousTurnId, tipTurnId])) {
      const turn = await this.store.getTurn({ session_id: this.session.session_id, turn_id: turnId });
      if (turn === undefined) {
        return false;
      }
      const waiting = pendingApprovalKeysOf(turn);
      if ([...wanted].some(key => waiting.has(key))) {
        return false;
      }
    }
    const issued = await this.issuedApprovalKeys({ wanted });
    if (issued.size !== wanted.size) {
      return false;
    }
    // A decision already on record is a resubmission, answered from stored state instead.
    const resubmission = await this.classifyApprovalResubmission({
      previous_turn_id: previousTurnId,
      decisions: items,
    });
    return resubmission.outcome === 'unrecorded';
  }

  /** Keys of the cards cleared after their request ended, for `withoutClearedApprovals`. */
  async clearedApprovalKeys(): Promise<ReadonlySet<string>> {
    const records = await this.store.listApprovalDismissals({ session_id: this.session.session_id });
    return new Set(records.map(record => approvalKey(record.thread_id, record.tool_call_id)));
  }

  /**
   * Clears the cards of ended requests. Nothing runs and no turn is created; the response reads the
   * turn the caller named, unchanged. Call only after `answersOnlyEndedApprovals` returned true.
   */
  async dismissEndedApprovals(input: {
    previous_turn_id?: string | undefined;
    input?: readonly TurnInputItem[] | undefined;
  }): Promise<TurnRecordWithoutSnapshot<TTurnCustom>> {
    const previousTurnId = resolvePreviousTurnId(input.previous_turn_id, this.session.last_turn_id);
    if (previousTurnId === null) {
      throw new Error('Unreachable: an ended approval names a previous turn');
    }
    const dismissedAt = new Date().toISOString();
    for (const item of input.input ?? []) {
      if (!isApprovalDecisionMessage(item)) {
        continue;
      }
      await this.store.recordApprovalDismissal({
        session_id: this.session.session_id,
        thread_id: item.thread_id,
        tool_call_id: item.tool_call_id,
        dismissed_at: dismissedAt,
      });
    }
    const turn = await this.getTurnRecord(previousTurnId);
    return withoutClearedApprovals(turn, await this.clearedApprovalKeys());
  }

  /**
   * Keys of the wanted approvals that some turn of this session issued. A new chat starts a root
   * turn, so the chain of `previous_turn_id` does not reach every paused turn; scan the session.
   */
  private async issuedApprovalKeys(input: { wanted: ReadonlySet<string> }): Promise<Set<string>> {
    const found = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.store.listTurns({
        session_id: this.session.session_id,
        limit: APPROVAL_SCAN_PAGE_SIZE,
        page_token: pageToken,
      });
      for (const turn of page.data) {
        for (const key of pendingApprovalKeysOf(turn)) {
          if (input.wanted.has(key)) {
            found.add(key);
          }
        }
      }
      pageToken = page.pagination.next_page_token;
    } while (pageToken !== undefined && found.size < input.wanted.size);
    return found;
  }

  /**
   * Matches a resubmitted approval batch against what the predecessor turn already
   * recorded. A client that sends the same decision twice (a retry, a double submit)
   * must not run the tool a second time, so the answer is read from stored state and
   * the batch is never re-sent.
   */
  async classifyApprovalResubmission(input: {
    previous_turn_id: string | undefined;
    decisions: readonly UserToolApprovalMessage[];
  }): Promise<ApprovalResubmission<TTurnCustom>> {
    if (input.decisions.length === 0) {
      return { outcome: 'unrecorded' };
    }

    // An accepted continuation advances the session tip, while a retried HTTP request still
    // names the original paused turn. Inspect the current tip first because it inherits the
    // recorded approval; then inspect the named predecessor for callers whose session view has
    // not advanced. Returning the stored tip makes an identical retry idempotent without ever
    // executing the tool again.
    const requestedPreviousTurnId = resolvePreviousTurnId(input.previous_turn_id, this.session.last_turn_id);
    const candidateTurnIds = [...new Set([this.session.last_turn_id, requestedPreviousTurnId])].filter(
      (turnId): turnId is string => turnId !== null,
    );

    for (const turnId of candidateTurnIds) {
      const candidate = await this.store.getTurn({
        session_id: this.session.session_id,
        turn_id: turnId,
      });
      if (candidate === undefined) {
        continue;
      }

      const submittedTurnDecisions = candidate.input.filter(isApprovalDecisionMessage);
      let allRecorded = true;
      for (const decision of input.decisions) {
        const submittedTurnDecision = submittedTurnDecisions.find(
          item => item.thread_id === decision.thread_id && item.tool_call_id === decision.tool_call_id,
        );
        const thread = candidate.snapshot.threads[decision.thread_id];
        const recorded =
          submittedTurnDecision?.approval ??
          (thread ? scanApprovalDecisions(thread.context).get(decision.tool_call_id) : undefined);
        if (recorded === undefined) {
          allRecorded = false;
          break;
        }
        if (!isSameApprovalDecision(recorded, decision.approval)) {
          return { outcome: 'conflict', tool_call_id: decision.tool_call_id };
        }
      }
      if (allRecorded) {
        return { outcome: 'replay', turn: candidate };
      }
    }

    return { outcome: 'unrecorded' };
  }

  /**
   * True when every item of the input turns down an action an unattended run held and nobody has
   * answered yet. Such a turn has nothing to run, so the caller ends it without a model call.
   * An approved held action is not one of these: its result goes back to the model, which continues.
   */
  async answersOnlyDeniedHeldActions(input: {
    previous_turn_id: string | undefined;
    input: readonly TurnInputItem[] | undefined;
  }): Promise<boolean> {
    const items = input.input ?? [];
    const previousTurnId = resolvePreviousTurnId(input.previous_turn_id, this.session.last_turn_id);
    if (items.length === 0 || previousTurnId === null || !items.every(isApprovalDecisionMessage)) {
      return false;
    }
    // A "Change it" denial hands the model the person's words, so the turn continues to a model call.
    if (!items.every(item => item.approval.status === 'deny' && !isChangeRequestReason(item.approval.reason))) {
      return false;
    }
    const previous = await this.store.getTurn({ session_id: this.session.session_id, turn_id: previousTurnId });
    return (
      previous !== undefined &&
      items.every(item => {
        const thread = previous.snapshot.threads[item.thread_id];
        return (
          thread !== undefined && findUndecidedHeldToolCalls(thread.context).some(call => call.id === item.tool_call_id)
        );
      })
    );
  }

  /**
   * Conditionally cancel a running turn in this session and return the
   * now-immutable record. Already-terminal turns are returned unchanged.
   * Missing turn → {@link TurnNotFoundError}.
   */
  async freezeTurn(input: {
    turn_id: string;
    reason: CancellationReason;
    handoff?: AbnormalHandoff | undefined;
  }): Promise<TurnRecord<TTurnCustom>> {
    const state: CancelledTurnState = {
      status: 'cancelled',
      reason: input.reason,
      completed_at: new Date().toISOString(),
      handoff:
        input.handoff ??
        mechanicalAbnormalHandoff({
          cause: abnormalHandoffCauseForCancellation(input.reason),
          repository: repositoryBindingFromSession(this.session),
        }),
    };
    return this.store.freezeAndGetTurn({
      session_id: this.session.session_id,
      turn_id: input.turn_id,
      turn_done_event: cancelledTurnDoneEvent(state),
    });
  }

  /** Returns the turn handle (store-backed; not executable), or undefined if not found. */
  async getTurn(turn_id: string): Promise<TurnHandle<TTurnCustom> | undefined> {
    return TurnHandle.get({
      store: this.store,
      session_id: this.session.session_id,
      turn_id,
    });
  }

  /** Paginated list of this session's turn rows (no snapshot). */
  async listTurns(input: {
    limit: number;
    page_token?: string | undefined;
  }): Promise<{ data: TurnRecordWithoutSnapshot<TTurnCustom>[]; pagination: TokenPagination }> {
    return this.store.listTurns({
      session_id: this.session.session_id,
      limit: input.limit,
      page_token: input.page_token,
    });
  }

  /**
   * Paginated session-wide feed of persisted events across turns, including
   * turn.created / turn.done lifecycle events. Reads from the store only —
   * nothing is synthesized on read.
   */
  async listEvents(input: {
    limit: number;
    page_token?: string | undefined;
    last_turn_id?: string | undefined;
    types?: readonly PersistedTurnEvent['type'][] | undefined;
    after_event_id?: string | undefined;
  }): Promise<{
    data: SessionEventItem[];
    pagination: TokenPagination;
  }> {
    return this.store.listSessionEvents({
      session_id: this.session.session_id,
      limit: input.limit,
      page_token: input.page_token,
      last_turn_id: input.last_turn_id,
      types: input.types,
      after_event_id: input.after_event_id,
    });
  }

  /** The predecessor turn as stored. Absence is a caller error, same as freezeTurn's. */
  private async getTurnRecord(turn_id: string): Promise<TurnRecord<TTurnCustom>> {
    const turn = await this.store.getTurn({
      session_id: this.session.session_id,
      turn_id,
    });
    if (turn === undefined) {
      throw new TurnNotFoundError(turn_id);
    }
    return turn;
  }

  private async resolveAgentDefinitions(input: {
    previous: TurnRecord<TTurnCustom> | undefined;
    resolver: ITurnResourceResolver<TTurnCustom>;
    spec: AgentSpec;
    tracing: AgentTracing;
    signal: AbortSignal;
    sentinelServices: SentinelServices;
  }): Promise<Map<string, ResolvedAgentDefinition>> {
    const snapshots = input.previous?.snapshot.threads;
    const threadIds = threadIdsForCurrentTurn(input.previous);
    const definitionsByThreadId = new Map<string, ResolvedAgentDefinition>();
    await Promise.all(
      threadIds.map(async threadId => {
        const previousThreadSnapshot = snapshots?.[threadId];
        const resolved = await input.resolver.resolveAgentDefinition({
          spec: input.spec,
          agent_info: previousThreadSnapshot?.agent_info ?? undefined,
          previousTurn: input.previous,
          signal: input.signal,
          tracing: input.tracing,
          tenant_id: this.session.tenant_id,
          created_by: this.session.created_by_subject.subject_id,
          session_id: this.session.session_id,
          sentinel_services: input.sentinelServices,
          workspace_cwd: this.session.workspace_cwd ?? null,
        });
        definitionsByThreadId.set(threadId, resolved);
      }),
    );
    return definitionsByThreadId;
  }

  private buildThreads(input: {
    previous: TurnRecord<TTurnCustom> | undefined;
    resolver: ITurnResourceResolver<TTurnCustom>;
    spec: AgentSpec;
    sandbox: Sandbox | undefined;
    tracing: AgentTracing;
    definitionsByThreadId: ReadonlyMap<string, ResolvedAgentDefinition>;
    chatApprovalGrants: Set<string>;
    loadImplementationPlanGrants: () => Promise<ReadonlySet<string>>;
    isRequestContinuation: boolean;
    sentinelServices: SentinelServices;
    stopAfterToolResponse: boolean;
  }): Map<string, AgentThread> {
    const snapshots = input.previous?.snapshot.threads;
    const map = new Map<string, AgentThread>();
    for (const threadId of threadIdsForCurrentTurn(input.previous)) {
      const resolvedDefinition = input.definitionsByThreadId.get(threadId);
      if (!resolvedDefinition) {
        throw new Error(`Unreachable: missing resolved agent definition for thread '${threadId}'`);
      }
      map.set(
        threadId,
        this.buildThread({
          threadId,
          previousThreadSnapshot: snapshots?.[threadId],
          resolver: input.resolver,
          spec: input.spec,
          sandbox: input.sandbox,
          tracing: input.tracing,
          resolvedDefinition,
          chatApprovalGrants: input.chatApprovalGrants,
          loadImplementationPlanGrants: input.loadImplementationPlanGrants,
          isRequestContinuation: input.isRequestContinuation,
          sentinelServices: input.sentinelServices,
          stopAfterToolResponse: input.stopAfterToolResponse,
        }),
      );
    }
    return map;
  }

  private buildThread(input: {
    threadId: string;
    previousThreadSnapshot?: AgentThreadSnapshot | undefined;
    resolver: ITurnResourceResolver<TTurnCustom>;
    spec: AgentSpec;
    sandbox: Sandbox | undefined;
    tracing: AgentTracing;
    resolvedDefinition: ResolvedAgentDefinition;
    chatApprovalGrants: Set<string>;
    loadImplementationPlanGrants: () => Promise<ReadonlySet<string>>;
    isRequestContinuation: boolean;
    sentinelServices: SentinelServices;
    stopAfterToolResponse: boolean;
  }): AgentThread {
    const { definition, extraCapabilities, compactionModel } = input.resolvedDefinition;
    const isChild = Boolean(input.previousThreadSnapshot?.parent);
    const sandbox = definition.readOnly ? undefined : input.sandbox;
    const capabilities = threadCapabilities({
      spec: input.spec,
      definition,
      compactionModel,
      isChild,
      sandbox,
      sandboxAvailable: Boolean(sandbox),
      tracing: input.tracing,
      logger: input.resolver.logger,
      compactionContext: input.resolver.compactionContext,
      compactionThresholdTokensDefault: input.resolver.compactionThresholdTokensDefault,
      boundRepository: input.resolver.boundRepository,
      extraCapabilities,
    });
    return new AgentThread({
      definition,
      threadId: input.threadId,
      title: input.previousThreadSnapshot?.agent_info?.name ?? (isChild ? input.threadId : 'main'),
      sandbox,
      context:
        input.previousThreadSnapshot === undefined
          ? undefined
          : stripLegacyHostContextMessages(input.previousThreadSnapshot.context),
      currentContextUsage: input.previousThreadSnapshot?.current_context_usage,
      parent: input.previousThreadSnapshot?.parent ?? undefined,
      agentInfo: input.previousThreadSnapshot?.agent_info ?? undefined,
      preComputedCompletion: input.previousThreadSnapshot?.completion ?? undefined,
      capabilities,
      capabilityState: input.previousThreadSnapshot?.capability_state ?? undefined,
      toolCallMemo: input.previousThreadSnapshot?.tool_call_memo,
      taskState: input.previousThreadSnapshot?.task_state,
      chatApprovalGrants: input.chatApprovalGrants,
      loadImplementationPlanGrants: input.loadImplementationPlanGrants,
      isRequestContinuation: input.isRequestContinuation,
      tracing: input.tracing,
      logger: input.resolver.logger,
      toolDispatchMaxConcurrency: input.resolver.toolDispatchMaxConcurrency,
      toolCallTimeoutMs: input.resolver.toolCallTimeoutMs,
      runCodeToolCallTimeoutMs: input.resolver.runCodeToolCallTimeoutMs,
      modelFirstResponseTimeoutMs: input.resolver.modelFirstResponseTimeoutMs,
      toolCallPolicy: input.resolver.toolCallPolicy,
      stopAfterToolResponse: input.stopAfterToolResponse,
      sentinel: this.createSentinelContext(input.sentinelServices, input.resolver.webSearchTurn),
    });
  }

  private makeCreateDynamicSubAgentThread(input: {
    resolver: ITurnResourceResolver<TTurnCustom>;
    previous: TurnRecord<TTurnCustom> | undefined;
    spec: AgentSpec;
    sandbox: Sandbox | undefined;
    tracing: AgentTracing;
    chatApprovalGrants: Set<string>;
    loadImplementationPlanGrants: () => Promise<ReadonlySet<string>>;
    sentinelServices: SentinelServices;
  }): CreateDynamicSubAgentThread {
    return async params => {
      throwIfSignalAborted(params.signal);
      // The checkout may have changed since the parent thread was built. The
      // shared sandbox is already configured by createTurn at this point.
      const refresh = params.parentDefinition.readOnly
        ? undefined
        : input.sandbox?.refreshBoundRepositoryState({ signal: params.signal });
      if (refresh !== undefined) {
        await awaitWithAbort({ operation: refresh, signal: params.signal });
      }
      throwIfSignalAborted(params.signal);
      const resolvedDefinition = await input.resolver.resolveAgentDefinition({
        spec: input.spec,
        agent_info: params.request,
        previousTurn: input.previous,
        signal: params.signal,
        tracing: input.tracing,
        tenant_id: this.session.tenant_id,
        created_by: this.session.created_by_subject.subject_id,
        session_id: this.session.session_id,
        sentinel_services: input.sentinelServices,
        workspace_cwd: this.session.workspace_cwd ?? null,
      });
      throwIfSignalAborted(params.signal);
      const { definition, extraCapabilities, compactionModel } = resolvedDefinition;
      // Model override (request.model) is resolved inside resolveAgentDefinition
      // into modelClient — do not re-label a stale client here.
      const childDefinition: AgentDefinition = {
        ...definition,
        toolSets: params.parentDefinition.toolSets ?? definition.toolSets,
        // A sub-agent of a read-only agent stays read-only, whatever definition it was resolved with.
        readOnly: params.parentDefinition.readOnly === true || definition.readOnly === true,
        // The delegated task goes in as the initial user message; the sub-agent
        // system prompt is SUB_AGENT_IDENTITY (added by AgentThread.buildInstruction).
        instruction: undefined,
        messages: [
          {
            role: 'user',
            content: params.request.workspace_cwd
              ? `Host-bound coding workspace: ${params.request.workspace_cwd}\nUse this checkout for all source inspection, edits, commands, and verification. Do not use GitHub connectors to read or edit source.\n\nDelegated task:\n${params.request.input}`
              : params.request.input,
          },
        ],
        // Sub-agents should return free-form summaries to the parent, not the user-facing structured response.
        responseFormat: undefined,
      };
      const sandbox = childDefinition.readOnly ? undefined : input.sandbox;
      const capabilities = threadCapabilities({
        spec: input.spec,
        definition: childDefinition,
        compactionModel,
        isChild: true,
        sandbox,
        sandboxAvailable: Boolean(sandbox),
        tracing: input.tracing,
        logger: input.resolver.logger,
        compactionContext: input.resolver.compactionContext,
        compactionThresholdTokensDefault: input.resolver.compactionThresholdTokensDefault,
        boundRepository: input.resolver.boundRepository,
        extraCapabilities,
      });
      throwIfSignalAborted(params.signal);
      return new AgentThread({
        definition: childDefinition,
        threadId: params.threadId,
        title: params.request.name,
        sandbox,
        parent: params.parent,
        agentInfo: params.request,
        capabilities,
        toolCallMemo: undefined,
        taskState: undefined,
        chatApprovalGrants: input.chatApprovalGrants,
        loadImplementationPlanGrants: input.loadImplementationPlanGrants,
        isRequestContinuation: false,
        tracing: input.tracing,
        logger: input.resolver.logger,
        toolDispatchMaxConcurrency: input.resolver.toolDispatchMaxConcurrency,
        toolCallTimeoutMs: input.resolver.toolCallTimeoutMs,
        runCodeToolCallTimeoutMs: input.resolver.runCodeToolCallTimeoutMs,
        modelFirstResponseTimeoutMs: input.resolver.modelFirstResponseTimeoutMs,
        toolCallPolicy: input.resolver.toolCallPolicy,
        sentinel: this.createSentinelContext(input.sentinelServices, input.resolver.webSearchTurn),
      });
    };
  }
}
