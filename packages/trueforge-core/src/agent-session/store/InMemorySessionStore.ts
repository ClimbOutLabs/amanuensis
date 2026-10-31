import { createToolResponseV2, newEventId } from '../../core/events/schema';
import {
  isSerializedImplementationPlanGrant,
  validateImplementationPlanGrant,
  type ImplementationPlanGrant,
} from '../../core/mcp/implementationPlanGrant';
import type { AgentThreadSnapshot } from '../../core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../core/runtime/contextUsage';
import type { SessionFolderRecord } from '../models/SessionFolderRecord';
import type { SessionRecord } from '../models/SessionRecord';
import type { TurnRecord, TurnSnapshot } from '../models/TurnRecord';
import type { PersistedTurnEvent, SessionEventItem } from '../schemas/events';
import type { TokenPagination } from '../schemas/pagination';
import { emptyTaskChecklist, TaskChecklistSchema } from '../schemas/taskChecklist';
import type { TerminalTurnState } from '../schemas/turn';
import { assertCreateTurnThreadDelta } from './assertCreateTurnThreadDelta';
import { buildChatSearchSnippet, chatSearchQueryTerms } from './chatSearchSnippet';
import type {
  AddThreadsAndAppendEventsInput,
  AddThreadsInput,
  AppendCommandExecutionResultInput,
  AppendCommandExecutionStartedInput,
  AppendToEventsInput,
  AppendToThreadContextInput,
  ApprovalDismissalRecord,
  BeginImplementationPlanDispatchInput,
  BeginImplementationPlanDispatchResult,
  ChatSearchDocument,
  ChatSearchHit,
  CommandExecutionRecord,
  CompleteImplementationPlanDispatchInput,
  CreateSessionFolderInput,
  CreateSessionInput,
  CreateTurnInput,
  DeleteSessionFolderInput,
  DeleteSessionInput,
  FreezeAndGetTurnInput,
  GetCommandExecutionInput,
  GetOwnedIdsInput,
  GetSessionByExternalIdInput,
  GetSessionFolderInput,
  GetSessionInput,
  GetTaskChecklistInput,
  GetTurnInput,
  ImplementationPlanTurnOwner,
  IndexChatMessagesInput,
  ISessionStore,
  ListApprovalDismissalsInput,
  ListImplementationPlanGrantsInput,
  ListSessionEventsInput,
  ListSessionFoldersInput,
  ListSessionsInput,
  ListTurnEventsInput,
  ListTurnsInput,
  NewThreadInit,
  OverwriteThreadContextInput,
  PatchMCPServersInput,
  PatchSandboxInfoInput,
  PatchThreadCapabilityStateInput,
  PersistImplementationPlanGrantInput,
  RecordApprovalDismissalInput,
  RecoverRunningCommandExecutionsInput,
  RemoveThreadsInput,
  RenewCommandExecutionLeaseInput,
  ReplaceTaskChecklistInput,
  RevokeImplementationPlanGrantInput,
  RevokeImplementationPlanGrantResult,
  SearchChatHistoryInput,
  SetSessionFolderInput,
  StampImportedSessionInput,
  TurnContextAppend,
  TurnRecordWithoutSnapshot,
  UpdateSessionFolderInput,
  UpdateSessionInput,
  UpdateTurnStateInput,
} from './ISessionStore';
import { decodeOffsetPageToken, encodeOffsetPageToken } from './OffsetPageToken';
import {
  decodeSessionEventPageToken,
  paginateSessionEventRows,
  sessionEventChainWindow,
} from './SessionEventPageToken';
import { decodeSessionListPageToken, paginateSessionListRows } from './SessionListPageToken';
import {
  ImplementationPlanGrantLifecycleError,
  PreviousTurnRunningError,
  SessionAlreadyExistsError,
  SessionExternalIdConflictError,
  SessionFolderNotFoundError,
  SessionNotFoundError,
  SessionStoreInvariantError,
  StaleApprovalContinuationError,
  StaleTaskChecklistError,
  TurnAlreadyExistsError,
  TurnNotFoundError,
  TurnNotRunningError,
} from './SessionStoreErrors';

/* eslint-disable @typescript-eslint/require-await -- in-memory store is synchronous; methods stay async so thrown SessionStore*Error reject as Promises for ISessionStore callers */

type StoredEvent = PersistedTurnEvent;

interface StoredImplementationPlanGrant {
  grant: ImplementationPlanGrant;
  revoked: boolean;
}

interface StoredImplementationPlanDispatch {
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  grant_id: string;
  workspace_cwd: string;
  checkout_id: string;
  state: 'dispatching' | 'completed';
}

interface StoredSession<TSessionCustom extends object> {
  record: SessionRecord<TSessionCustom>;
  turnIds: string[];
}

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function sessionKey(sessionId: string): string {
  return sessionId;
}

function turnKey({ session_id, turn_id }: { session_id: string; turn_id: string }): string {
  return `${session_id}:${turn_id}`;
}

function commandExecutionKey(input: {
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
}): string {
  return `${input.session_id}:${input.turn_id}:${input.thread_id}:${input.tool_call_id}`;
}

/** Lexicographic session_id order — shared by listSessions sort and keyset filter. */
function compareSessionId(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function newThreadSnapshot(thread: NewThreadInit): AgentThreadSnapshot {
  return {
    thread_id: thread.thread_id,
    parent: thread.parent ?? null,
    agent_info: thread.agent_info ?? null,
    capability_state: null,
    context: [],
    current_context_usage: getEmptyCurrentContextUsage(),
    completion: null,
    tool_call_memo: thread.tool_call_memo === undefined ? undefined : deepCopy(thread.tool_call_memo),
    task_state: thread.task_state === undefined ? undefined : deepCopy(thread.task_state),
  };
}

function applyContextAppends(threads: Record<string, AgentThreadSnapshot>, appends: TurnContextAppend[]): void {
  for (const append of appends) {
    const thread = threads[append.thread_id];
    if (!thread) {
      throw new SessionStoreInvariantError(`new_context_appends references unknown thread ${append.thread_id}`);
    }
    thread.context.push(...deepCopy(append.context));
    if (append.current_context_usage !== null) {
      thread.current_context_usage = deepCopy(append.current_context_usage);
    }
  }
}

function buildSnapshotFromDelta(input: {
  previousSnapshot: TurnSnapshot | undefined;
  sandbox_info: CreateTurnInput['sandbox_info'];
  retained_previous_thread_ids: CreateTurnInput['retained_previous_thread_ids'];
  new_threads: NewThreadInit[];
  new_context_appends: TurnContextAppend[];
  capability_states: CreateTurnInput['capability_states'];
  tool_call_memos: CreateTurnInput['tool_call_memos'];
  task_states: CreateTurnInput['task_states'];
}): TurnSnapshot {
  const previousThreads = input.previousSnapshot?.threads ?? {};

  assertCreateTurnThreadDelta({
    previousThreadIds: new Set(Object.keys(previousThreads)),
    retained_previous_thread_ids: input.retained_previous_thread_ids,
    new_threads: input.new_threads,
    new_context_appends: input.new_context_appends,
    capability_states: input.capability_states,
  });

  const threads: Record<string, AgentThreadSnapshot> = {};
  for (const threadId of input.retained_previous_thread_ids) {
    const previousThread = previousThreads[threadId];
    if (previousThread === undefined) {
      throw new SessionStoreInvariantError(`retained_previous_thread_ids references unknown thread ${threadId}`);
    }
    threads[threadId] = deepCopy(previousThread);
  }

  for (const nt of input.new_threads) {
    threads[nt.thread_id] = newThreadSnapshot(nt);
  }

  applyContextAppends(threads, input.new_context_appends);
  for (const capability of input.capability_states) {
    const thread = threads[capability.thread_id];
    if (thread === undefined) {
      throw new SessionStoreInvariantError(`capability_states references unknown thread ${capability.thread_id}`);
    }
    thread.capability_state = deepCopy(capability.capability_state);
  }
  for (const memo of input.tool_call_memos) {
    const thread = threads[memo.thread_id];
    if (thread === undefined) {
      throw new SessionStoreInvariantError(`tool_call_memos references unknown thread ${memo.thread_id}`);
    }
    thread.tool_call_memo = memo.tool_call_memo === undefined ? undefined : deepCopy(memo.tool_call_memo);
  }
  for (const taskState of input.task_states) {
    const thread = threads[taskState.thread_id];
    if (thread === undefined) {
      throw new SessionStoreInvariantError(`task_states references unknown thread ${taskState.thread_id}`);
    }
    thread.task_state = taskState.task_state === undefined ? undefined : deepCopy(taskState.task_state);
  }

  return {
    threads,
    mcp_servers: input.previousSnapshot ? deepCopy(input.previousSnapshot.mcp_servers) : null,
    sandbox_info: input.sandbox_info ?? (input.previousSnapshot ? deepCopy(input.previousSnapshot.sandbox_info) : null),
  };
}

function paginate<T>(items: T[], limit: number, pageToken?: string): { data: T[]; pagination: TokenPagination } {
  const offset = decodeOffsetPageToken(pageToken);
  const slice = items.slice(offset, offset + limit);
  return {
    data: slice,
    pagination: {
      limit,
      ...(offset + limit < items.length ? { next_page_token: encodeOffsetPageToken(offset + limit) } : {}),
      ...(offset > 0 ? { previous_page_token: encodeOffsetPageToken(Math.max(0, offset - limit)) } : {}),
    },
  };
}

/**
 * Reference ISessionStore implementation. Proves the contract without SSE/subscription
 * hooks. Deep-copies on read/write boundaries so callers cannot mutate stored state.
 */
export class InMemorySessionStore<
  TSessionCustom extends object = Record<string, never>,
  TTurnCustom extends object = Record<string, never>,
> implements ISessionStore<TSessionCustom, TTurnCustom> {
  private readonly sessions = new Map<string, StoredSession<TSessionCustom>>();
  private readonly sessionFolders = new Map<string, SessionFolderRecord>();
  private readonly turns = new Map<string, TurnRecord<TTurnCustom>>();
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly commandExecutions = new Map<string, CommandExecutionRecord>();
  private readonly implementationPlanGrants = new Map<string, Map<string, StoredImplementationPlanGrant>>();
  private readonly implementationPlanDispatches = new Map<string, StoredImplementationPlanDispatch>();
  private readonly approvalDismissals = new Map<string, Map<string, ApprovalDismissalRecord>>();
  private readonly chatSearchDocuments = new Map<string, Map<string, ChatSearchDocument & { turn_id: string }>>();

  async createSession(input: CreateSessionInput<TSessionCustom>): Promise<void> {
    const key = sessionKey(input.session_id);
    if (this.sessions.has(key)) {
      throw new SessionAlreadyExistsError(input.session_id);
    }
    const externalId = input.external_id;
    if (externalId !== null) {
      for (const stored of this.sessions.values()) {
        if (stored.record.tenant_id === input.tenant_id && stored.record.external_id === externalId) {
          throw new SessionExternalIdConflictError(externalId);
        }
      }
    }
    const now = new Date();
    const record: SessionRecord<TSessionCustom> = {
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      created_by_subject: input.created_by_subject,
      agent: deepCopy(input.agent),
      title: null,
      folder_id: null,
      repository_id: null,
      workspace_cwd: null,
      last_turn_id: null,
      external_id: externalId,
      source: input.source !== null ? deepCopy(input.source) : null,
      created_at: now,
      updated_at: now,
      last_activity_timestamp_ms: Date.now(),
      approval_grants: [],
      task_checklist: emptyTaskChecklist(),
      metrics: {
        total_duration_ms: 0,
        total_turns: 0,
      },
      metadata: deepCopy(input.metadata),
      custom: input.custom !== null ? deepCopy(input.custom) : null,
    };
    this.sessions.set(key, { record, turnIds: [] });
    return;
  }

  async stampImportedSession(input: StampImportedSessionInput): Promise<void> {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (stored?.record.tenant_id !== input.tenant_id) {
      throw new SessionNotFoundError(input.session_id);
    }
    const stamped = input.turns.map(entry => {
      const turn = this.turns.get(turnKey({ session_id: input.session_id, turn_id: entry.turn_id }));
      if (turn === undefined) {
        throw new TurnNotFoundError(entry.turn_id);
      }
      return { turn, entry };
    });
    for (const { turn, entry } of stamped) {
      turn.created_at = new Date(entry.created_at);
      turn.updated_at = new Date(entry.updated_at);
    }
    stored.record.created_at = new Date(input.created_at);
    stored.record.updated_at = new Date(input.updated_at);
    stored.record.last_activity_timestamp_ms = input.last_activity_timestamp_ms;
    stored.record.metrics = deepCopy(input.metrics);
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    const sKey = sessionKey(input.session_id);
    const stored = this.sessions.get(sKey);
    if (stored?.record.tenant_id !== input.tenant_id) {
      return;
    }
    for (const turnId of stored.turnIds) {
      const tKey = turnKey({ session_id: input.session_id, turn_id: turnId });
      this.turns.delete(tKey);
      this.events.delete(tKey);
      for (const [executionKey, execution] of this.commandExecutions) {
        if (execution.session_id === input.session_id && execution.turn_id === turnId) {
          this.commandExecutions.delete(executionKey);
        }
      }
    }
    this.implementationPlanGrants.delete(sKey);
    this.approvalDismissals.delete(sKey);
    this.chatSearchDocuments.delete(sKey);
    for (const [dispatchKey, dispatch] of this.implementationPlanDispatches) {
      if (dispatch.session_id === input.session_id) {
        this.implementationPlanDispatches.delete(dispatchKey);
      }
    }
    this.sessions.delete(sKey);
  }

  async indexChatMessages(input: IndexChatMessagesInput): Promise<void> {
    const sKey = sessionKey(input.session_id);
    const stored = this.sessions.get(sKey);
    if (stored?.record.tenant_id !== input.tenant_id) {
      return;
    }
    let byMessage = this.chatSearchDocuments.get(sKey);
    if (byMessage === undefined) {
      byMessage = new Map();
      this.chatSearchDocuments.set(sKey, byMessage);
    }
    for (const [messageId, document] of byMessage) {
      if (document.turn_id === input.turn_id) {
        byMessage.delete(messageId);
      }
    }
    for (const document of input.documents) {
      byMessage.set(document.message_id, { ...document, turn_id: input.turn_id });
    }
  }

  async searchChatHistory(input: SearchChatHistoryInput): Promise<ChatSearchHit[]> {
    const terms = chatSearchQueryTerms(input.query);
    if (terms.length === 0 || input.limit <= 0) {
      return [];
    }
    const bestBySession = new Map<string, { session: SessionRecord<TSessionCustom>; text: string; matchedAt: Date }>();
    for (const [sKey, byMessage] of this.chatSearchDocuments) {
      const stored = this.sessions.get(sKey);
      if (stored === undefined) {
        continue;
      }
      const { record } = stored;
      if (record.tenant_id !== input.tenant_id) {
        continue;
      }
      if (record.created_by_subject.subject_id !== input.created_by_subject_id) {
        continue;
      }
      if (input.exclude_session_id !== null && record.session_id === input.exclude_session_id) {
        continue;
      }
      for (const document of byMessage.values()) {
        if (input.from !== null && document.created_at < input.from) {
          continue;
        }
        if (input.to !== null && document.created_at >= input.to) {
          continue;
        }
        const lower = document.text.toLowerCase();
        const matched = terms.filter(term => lower.includes(term));
        if (matched.length < terms.length) {
          continue;
        }
        const current = bestBySession.get(record.session_id);
        if (current === undefined || document.created_at > current.matchedAt) {
          bestBySession.set(record.session_id, {
            session: record,
            text: document.text,
            matchedAt: document.created_at,
          });
        }
      }
    }
    return [...bestBySession.values()]
      .sort((a, b) => b.matchedAt.getTime() - a.matchedAt.getTime())
      .slice(0, input.limit)
      .map(entry => ({
        session_id: entry.session.session_id,
        title: entry.session.title,
        created_at: entry.session.created_at,
        snippet: buildChatSearchSnippet(entry.text, input.query),
      }));
  }

  private implementationPlanOwnerMatches(input: ListImplementationPlanGrantsInput): boolean {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (
      stored?.record.tenant_id !== input.tenant_id ||
      stored.record.created_by_subject.subject_id !== input.created_by
    ) {
      return false;
    }
    return true;
  }

  private implementationPlanRunningTurn(input: ImplementationPlanTurnOwner): boolean {
    if (!this.implementationPlanOwnerMatches(input)) {
      return false;
    }
    const stored = this.sessions.get(sessionKey(input.session_id));
    const turn = this.turns.get(turnKey(input));
    if (stored?.record.last_turn_id !== input.turn_id || turn?.state.status !== 'running') {
      throw new ImplementationPlanGrantLifecycleError(input.turn_id);
    }
    return true;
  }

  private implementationPlanGrantMatchesSessionBinding(grant: ImplementationPlanGrant): boolean {
    const session = this.sessions.get(sessionKey(grant.session_id))?.record;
    if (session === undefined) {
      return false;
    }
    return (
      session.repository_id !== null &&
      session.workspace_cwd !== null &&
      session.repository_id === grant.plan.repository_id &&
      session.workspace_cwd === grant.workspace_cwd
    );
  }

  async listImplementationPlanGrants(input: ListImplementationPlanGrantsInput): Promise<ImplementationPlanGrant[]> {
    if (!this.implementationPlanOwnerMatches(input)) {
      return [];
    }
    const grants = [...(this.implementationPlanGrants.get(sessionKey(input.session_id))?.values() ?? [])]
      .filter(stored => !stored.revoked && this.implementationPlanGrantMatchesSessionBinding(stored.grant))
      .map(stored => stored.grant);
    grants.sort((left, right) => left.grant_id.localeCompare(right.grant_id));
    return deepCopy(grants);
  }

  async persistImplementationPlanGrant(input: PersistImplementationPlanGrantInput): Promise<void> {
    const grant = validateImplementationPlanGrant(input.grant);
    const stored = grant === undefined ? undefined : this.sessions.get(sessionKey(grant.session_id));
    if (
      grant === undefined ||
      stored?.record.tenant_id !== grant.tenant_id ||
      stored.record.created_by_subject.subject_id !== grant.created_by ||
      !this.implementationPlanGrantMatchesSessionBinding(grant)
    ) {
      throw new SessionStoreInvariantError('Implementation-plan grant owner or integrity does not match its session');
    }
    this.implementationPlanRunningTurn({
      tenant_id: grant.tenant_id,
      created_by: grant.created_by,
      session_id: grant.session_id,
      turn_id: input.turn_id,
    });
    const sKey = sessionKey(grant.session_id);
    const grants = this.implementationPlanGrants.get(sKey) ?? new Map<string, StoredImplementationPlanGrant>();
    grants.set(grant.grant_id, { grant: deepCopy(grant), revoked: false });
    this.implementationPlanGrants.set(sKey, grants);
  }

  async revokeImplementationPlanGrant(
    input: RevokeImplementationPlanGrantInput,
  ): Promise<RevokeImplementationPlanGrantResult> {
    if (!this.implementationPlanOwnerMatches(input)) {
      return { status: 'absent' };
    }
    const storedGrant = this.implementationPlanGrants.get(sessionKey(input.session_id))?.get(input.grant_id);
    if (storedGrant === undefined || !this.implementationPlanGrantMatchesSessionBinding(storedGrant.grant)) {
      return { status: 'absent' };
    }
    storedGrant.revoked = true;
    const pending = [...this.implementationPlanDispatches.values()].some(
      dispatch =>
        dispatch.session_id === input.session_id &&
        dispatch.grant_id === input.grant_id &&
        dispatch.state === 'dispatching',
    );
    return { status: pending ? 'pending' : 'revoked' };
  }

  async beginImplementationPlanDispatch(
    input: BeginImplementationPlanDispatchInput,
  ): Promise<BeginImplementationPlanDispatchResult> {
    if (!this.implementationPlanRunningTurn(input)) {
      return { status: 'blocked' };
    }
    const dispatchKey = `${input.session_id}\u0000${input.turn_id}\u0000${input.dispatch_id}`;
    const storedGrant = this.implementationPlanGrants.get(sessionKey(input.session_id))?.get(input.grant_id);
    if (
      this.implementationPlanDispatches.has(dispatchKey) ||
      storedGrant === undefined ||
      storedGrant.revoked ||
      storedGrant.grant.tenant_id !== input.tenant_id ||
      storedGrant.grant.created_by !== input.created_by ||
      storedGrant.grant.session_id !== input.session_id ||
      storedGrant.grant.grant_id !== input.grant_id ||
      !this.implementationPlanGrantMatchesSessionBinding(storedGrant.grant) ||
      storedGrant.grant.checkout_id !== input.checkout_id
    ) {
      return { status: 'blocked' };
    }
    this.implementationPlanDispatches.set(dispatchKey, {
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      turn_id: input.turn_id,
      grant_id: input.grant_id,
      workspace_cwd: storedGrant.grant.workspace_cwd,
      checkout_id: input.checkout_id,
      state: 'dispatching',
    });
    return { status: 'admitted' };
  }

  async completeImplementationPlanDispatch(input: CompleteImplementationPlanDispatchInput): Promise<void> {
    const dispatch = this.implementationPlanDispatches.get(
      `${input.session_id}\u0000${input.turn_id}\u0000${input.dispatch_id}`,
    );
    if (
      dispatch?.tenant_id !== input.tenant_id ||
      dispatch.created_by !== input.created_by ||
      dispatch.turn_id !== input.turn_id ||
      dispatch.grant_id !== input.grant_id
    ) {
      throw new SessionStoreInvariantError('Implementation-plan dispatch reservation is missing');
    }
    if (dispatch.state === 'completed') {
      return;
    }
    dispatch.state = 'completed';
  }

  async getSession(input: GetSessionInput): Promise<SessionRecord<TSessionCustom> | undefined> {
    const stored = this.sessions.get(sessionKey(input.session_id));
    return stored?.record.tenant_id === input.tenant_id ? deepCopy(stored.record) : undefined;
  }

  setSessionRepositoryBindingForTest(input: {
    tenant_id: string;
    created_by: string;
    session_id: string;
    repository_id: string | null;
    workspace_cwd: string | null;
  }): void {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (
      stored?.record.tenant_id !== input.tenant_id ||
      stored.record.created_by_subject.subject_id !== input.created_by
    ) {
      throw new SessionNotFoundError(input.session_id);
    }
    if ((input.repository_id === null) !== (input.workspace_cwd === null)) {
      throw new SessionStoreInvariantError('Repository id and workspace cwd must be set or cleared together');
    }
    stored.record.repository_id = input.repository_id;
    stored.record.workspace_cwd = input.workspace_cwd;
  }

  async getTaskChecklist(input: GetTaskChecklistInput) {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (stored?.record.tenant_id !== input.tenant_id) {
      throw new SessionNotFoundError(input.session_id);
    }
    return deepCopy(stored.record.task_checklist);
  }

  async replaceTaskChecklist(input: ReplaceTaskChecklistInput) {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (stored?.record.tenant_id !== input.tenant_id) {
      throw new SessionNotFoundError(input.session_id);
    }
    const current = stored.record.task_checklist;
    if (current.revision !== input.expected_revision) {
      throw new StaleTaskChecklistError(input.expected_revision, deepCopy(current));
    }
    const next = TaskChecklistSchema.parse({ revision: current.revision + 1, items: input.items });
    stored.record.task_checklist = deepCopy(next);
    stored.record.updated_at = new Date();
    stored.record.last_activity_timestamp_ms = Date.now();
    return deepCopy(next);
  }

  async getOwnedIds(input: GetOwnedIdsInput): Promise<readonly string[]> {
    if (input.ids.length === 0) {
      return [];
    }
    const wanted = new Set(input.ids);
    const ids: string[] = [];
    for (const stored of this.sessions.values()) {
      if (
        stored.record.tenant_id === input.tenant_id &&
        wanted.has(stored.record.session_id) &&
        stored.record.created_by_subject.subject_id === input.subject_id
      ) {
        ids.push(stored.record.session_id);
      }
    }
    return ids;
  }

  async getSessionByExternalId(input: GetSessionByExternalIdInput): Promise<SessionRecord<TSessionCustom> | undefined> {
    for (const stored of this.sessions.values()) {
      if (stored.record.tenant_id === input.tenant_id && stored.record.external_id === input.external_id) {
        return deepCopy(stored.record);
      }
    }
    return undefined;
  }

  async updateSession(input: UpdateSessionInput<TSessionCustom>): Promise<void> {
    const key = sessionKey(input.session_id);
    const stored = this.sessions.get(key);
    if (stored?.record.tenant_id !== input.tenant_id) {
      throw new SessionNotFoundError(input.session_id);
    }
    if (input.agent !== undefined) {
      if (stored.record.agent.type === 'reference') {
        throw new SessionStoreInvariantError(`Session ${input.session_id} is named; agent cannot be updated`);
      }
      stored.record.agent = deepCopy(input.agent);
    }
    if (input.title !== undefined) {
      stored.record.title = input.title;
    }
    if (input.metadata !== undefined) {
      stored.record.metadata = deepCopy(input.metadata);
    }
    const now = Date.now();
    stored.record.updated_at = new Date(now);
    stored.record.last_activity_timestamp_ms = now;
    return;
  }

  async createSessionFolder(input: CreateSessionFolderInput): Promise<SessionFolderRecord> {
    const now = new Date();
    const record: SessionFolderRecord = {
      tenant_id: input.tenant_id,
      folder_id: input.folder_id,
      created_by: input.created_by,
      name: input.name,
      created_at: now,
      updated_at: now,
    };
    this.sessionFolders.set(input.folder_id, deepCopy(record));
    return deepCopy(record);
  }

  async getSessionFolder(input: GetSessionFolderInput): Promise<SessionFolderRecord | undefined> {
    const folder = this.sessionFolders.get(input.folder_id);
    if (folder?.tenant_id !== input.tenant_id || folder.created_by !== input.created_by) {
      return undefined;
    }
    return deepCopy(folder);
  }

  async listSessionFolders(input: ListSessionFoldersInput): Promise<SessionFolderRecord[]> {
    return [...this.sessionFolders.values()]
      .filter(folder => folder.tenant_id === input.tenant_id && folder.created_by === input.created_by)
      .sort((left, right) => left.name.localeCompare(right.name) || left.folder_id.localeCompare(right.folder_id))
      .map(deepCopy);
  }

  async updateSessionFolder(input: UpdateSessionFolderInput): Promise<SessionFolderRecord | undefined> {
    const folder = this.sessionFolders.get(input.folder_id);
    if (folder?.tenant_id !== input.tenant_id || folder.created_by !== input.created_by) {
      return undefined;
    }
    folder.name = input.name;
    folder.updated_at = new Date();
    return deepCopy(folder);
  }

  async deleteSessionFolder(input: DeleteSessionFolderInput): Promise<void> {
    const folder = this.sessionFolders.get(input.folder_id);
    if (folder?.tenant_id !== input.tenant_id || folder.created_by !== input.created_by) {
      return;
    }
    this.sessionFolders.delete(input.folder_id);
    for (const session of this.sessions.values()) {
      if (session.record.folder_id === input.folder_id) {
        session.record.folder_id = null;
      }
    }
  }

  async recordApprovalDismissal(input: RecordApprovalDismissalInput): Promise<void> {
    const sKey = sessionKey(input.session_id);
    const dismissals = this.approvalDismissals.get(sKey) ?? new Map<string, ApprovalDismissalRecord>();
    const key = `${input.thread_id}\u0000${input.tool_call_id}`;
    if (!dismissals.has(key)) {
      dismissals.set(key, {
        thread_id: input.thread_id,
        tool_call_id: input.tool_call_id,
        dismissed_at: input.dismissed_at,
      });
    }
    this.approvalDismissals.set(sKey, dismissals);
  }

  async listApprovalDismissals(input: ListApprovalDismissalsInput): Promise<ApprovalDismissalRecord[]> {
    return [...(this.approvalDismissals.get(sessionKey(input.session_id))?.values() ?? [])].map(record => ({
      ...record,
    }));
  }

  async setSessionFolder(input: SetSessionFolderInput): Promise<void> {
    const session = this.sessions.get(sessionKey(input.session_id));
    if (
      session?.record.tenant_id !== input.tenant_id ||
      session.record.created_by_subject.subject_id !== input.created_by
    ) {
      throw new SessionNotFoundError(input.session_id);
    }
    if (input.folder_id !== null) {
      const folder = this.sessionFolders.get(input.folder_id);
      if (folder?.tenant_id !== input.tenant_id || folder.created_by !== input.created_by) {
        throw new SessionFolderNotFoundError(input.folder_id);
      }
    }
    session.record.folder_id = input.folder_id;
  }

  async listSessions(
    input: ListSessionsInput,
  ): Promise<{ data: SessionRecord<TSessionCustom>[]; pagination: TokenPagination }> {
    const records: SessionRecord<TSessionCustom>[] = [];
    const createdByOrAgentIds = input.created_by_or_agent_ids;
    for (const stored of this.sessions.values()) {
      if (stored.record.tenant_id !== input.tenant_id) {
        continue;
      }
      if (
        input.agent_id !== undefined &&
        (stored.record.agent.type !== 'reference' || stored.record.agent.id !== input.agent_id)
      ) {
        continue;
      }
      if (input.folder_id !== undefined && stored.record.folder_id !== input.folder_id) {
        continue;
      }
      if (input.no_folder && stored.record.folder_id !== null) {
        continue;
      }
      if (createdByOrAgentIds !== undefined) {
        const creatorMatches =
          stored.record.created_by_subject.subject_id === createdByOrAgentIds.created_by_subject_id;
        const agentMatches =
          stored.record.agent.type === 'reference' && createdByOrAgentIds.agent_ids.includes(stored.record.agent.id);
        if (!creatorMatches && !agentMatches) {
          continue;
        }
      }
      const metadataFilter = input.metadata;
      if (metadataFilter !== undefined) {
        const entries = Object.entries(metadataFilter);
        if (entries.length === 0) {
          if (Object.keys(stored.record.metadata).length > 0) {
            continue;
          }
        } else if (!entries.every(([key, value]) => stored.record.metadata[key] === value)) {
          continue;
        }
      }
      if (input.source_type !== undefined && stored.record.source?.type !== input.source_type) {
        continue;
      }
      if (input.source_id !== undefined && stored.record.source?.id !== input.source_id) {
        continue;
      }
      const createdAt = stored.record.created_at.getTime();
      if (input.start_timestamp !== undefined && createdAt < input.start_timestamp.getTime()) {
        continue;
      }
      if (input.end_timestamp !== undefined && createdAt > input.end_timestamp.getTime()) {
        continue;
      }
      records.push(stored.record);
    }
    records.sort((a, b) => {
      const aTime = a.updated_at.getTime();
      const bTime = b.updated_at.getTime();
      if (aTime !== bTime) {
        return input.order === 'asc' ? aTime - bTime : bTime - aTime;
      }
      // Same lexicographic order as the keyset predicate below (and Postgres/SQLite).
      return input.order === 'asc'
        ? compareSessionId(a.session_id, b.session_id)
        : compareSessionId(b.session_id, a.session_id);
    });

    let filtered = records;
    const cursor = decodeSessionListPageToken(input.page_token);
    if (cursor) {
      const cursorTime = new Date(cursor.updated_at).getTime();
      filtered = records.filter(record => {
        const t = record.updated_at.getTime();
        const idCmp = compareSessionId(record.session_id, cursor.session_id);
        if (input.order === 'asc') {
          return t > cursorTime || (t === cursorTime && idCmp > 0);
        }
        return t < cursorTime || (t === cursorTime && idCmp < 0);
      });
    }

    const page = paginateSessionListRows(filtered, input.limit, row => row.updated_at.toISOString());
    return { data: deepCopy(page.data), pagination: page.pagination };
  }

  async createTurn(input: CreateTurnInput<TTurnCustom>): Promise<void> {
    // Atomicity is free here: this body is fully synchronous, so Node's
    // run-to-completion guarantees it. Real backends must still use their own
    // locking/transactions to satisfy the ISessionStore createTurn contract.
    const sKey = sessionKey(input.turn.session_id);
    const stored = this.sessions.get(sKey);
    if (!stored) {
      throw new SessionNotFoundError(input.turn.session_id);
    }

    const previousTurnId = input.turn.previous_turn_id;
    if (input.require_previous_turn_is_tip && previousTurnId !== stored.record.last_turn_id) {
      throw new StaleApprovalContinuationError(previousTurnId, stored.record.last_turn_id);
    }
    // One reply at a time: whatever the parent, a new turn waits until the chat's latest turn ends.
    const tipTurnId = stored.record.last_turn_id;
    if (tipTurnId !== null) {
      const tip = this.turns.get(turnKey({ session_id: input.turn.session_id, turn_id: tipTurnId }));
      if (tip?.state.status === 'running') {
        throw new PreviousTurnRunningError(tipTurnId);
      }
    }
    let previousSnapshot: TurnSnapshot | undefined;
    if (previousTurnId !== null) {
      const prevKey = turnKey({ session_id: input.turn.session_id, turn_id: previousTurnId });
      const prev = this.turns.get(prevKey);
      // Unknown previous_turn_id is allowed (relaxed): treat as no inheritance.
      // A still-running previous must be frozen first.
      if (prev !== undefined) {
        if (prev.state.status === 'running') {
          throw new PreviousTurnRunningError(previousTurnId);
        }
        previousSnapshot = prev.snapshot;
      }
    }

    const tKey = turnKey(input.turn);
    if (this.turns.has(tKey)) {
      throw new TurnAlreadyExistsError(input.turn.turn_id);
    }

    const snapshot = buildSnapshotFromDelta({
      previousSnapshot,
      sandbox_info: input.sandbox_info,
      retained_previous_thread_ids: input.retained_previous_thread_ids,
      new_threads: input.new_threads,
      new_context_appends: input.new_context_appends,
      capability_states: input.capability_states,
      tool_call_memos: input.tool_call_memos,
      task_states: input.task_states,
    });

    const turnRecord: TurnRecord<TTurnCustom> = {
      ...deepCopy(input.turn),
      snapshot,
    };

    this.turns.set(tKey, turnRecord);
    this.events.set(tKey, []);
    stored.turnIds.push(input.turn.turn_id);
    stored.record.last_turn_id = input.turn.turn_id;
    stored.record.approval_grants = [
      ...new Set(
        [...stored.record.approval_grants, ...input.approval_grants].filter(
          value => !isSerializedImplementationPlanGrant(value),
        ),
      ),
    ].sort();
    stored.record.metrics.total_turns += 1;
    stored.record.last_activity_timestamp_ms = Date.now();
    stored.record.updated_at = new Date();
    if (input.update_session_title_if_not_exist !== null && stored.record.title === null) {
      stored.record.title = input.update_session_title_if_not_exist;
    }
  }

  async freezeAndGetTurn(input: FreezeAndGetTurnInput): Promise<TurnRecord<TTurnCustom>> {
    const tKey = turnKey(input);
    const turn = this.requireTurn(input.session_id, input.turn_id);
    const state = input.turn_done_event.state;
    if (state.status !== 'cancelled' || state.handoff === undefined) {
      throw new SessionStoreInvariantError('freezeAndGetTurn requires a cancelled turn.done event with a handoff');
    }
    if (input.reason !== undefined && input.reason !== state.reason) {
      throw new SessionStoreInvariantError('freezeAndGetTurn reason must match the cancelled turn.done event');
    }

    if (turn.state.status === 'running') {
      turn.state = deepCopy(state);
      turn.updated_at = new Date();
      this.closeRunningCommandExecutions(input.session_id, input.turn_id, new Date(state.completed_at));
      const list = this.events.get(tKey);
      if (list) {
        list.push(deepCopy(input.turn_done_event));
      }
      this.addTerminalSessionMetrics(input.session_id, turn.created_at, state);
    }

    return deepCopy(turn);
  }

  async getTurn(input: GetTurnInput): Promise<TurnRecord<TTurnCustom> | undefined> {
    const turn = this.turns.get(turnKey(input));
    return turn ? deepCopy(turn) : undefined;
  }

  async listTurns(
    input: ListTurnsInput,
  ): Promise<{ data: TurnRecordWithoutSnapshot<TTurnCustom>[]; pagination: TokenPagination }> {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (!stored) {
      throw new SessionNotFoundError(input.session_id);
    }
    const records = stored.turnIds.map(id => {
      const turn = this.turns.get(turnKey({ session_id: input.session_id, turn_id: id }));
      if (!turn) {
        throw new TurnNotFoundError(id);
      }
      const { snapshot, ...row } = deepCopy(turn);
      void snapshot;
      return row;
    });
    return paginate(records, input.limit, input.page_token);
  }

  async updateTurnState(input: UpdateTurnStateInput): Promise<void> {
    // Same as createTurn: synchronous body ⇒ atomic under run-to-completion.
    const tKey = turnKey(input);
    const turn = this.requireTurn(input.session_id, input.turn_id);
    if (turn.state.status !== 'running') {
      throw new TurnNotRunningError(input.turn_id, turn.state);
    }
    turn.state = deepCopy(input.state);
    turn.updated_at = new Date();
    this.closeRunningCommandExecutions(input.session_id, input.turn_id, new Date(input.state.completed_at));
    const list = this.events.get(tKey);
    if (list) {
      list.push(deepCopy(input.turn_done_event));
    }
    this.addTerminalSessionMetrics(input.session_id, turn.created_at, input.state);
  }

  async appendToEvents(input: AppendToEventsInput): Promise<void> {
    this.requireRunningTurn(input.session_id, input.turn_id);
    const tKey = turnKey(input);
    const list = this.events.get(tKey);
    if (!list) {
      throw new TurnNotFoundError(input.turn_id);
    }
    list.push(...deepCopy(input.events));
    return;
  }

  async appendCommandExecutionStarted(input: AppendCommandExecutionStartedInput): Promise<void> {
    this.requireRunningTurn(input.session_id, input.turn_id);
    const key = commandExecutionKey({
      session_id: input.session_id,
      turn_id: input.turn_id,
      thread_id: input.event.thread_id,
      tool_call_id: input.event.tool_call_id,
    });
    if (this.commandExecutions.has(key)) {
      throw new SessionStoreInvariantError(`command execution ${input.event.tool_call_id} already exists`);
    }
    const eventList = this.events.get(turnKey(input));
    if (eventList === undefined) {
      throw new TurnNotFoundError(input.turn_id);
    }
    eventList.push(deepCopy(input.event));
    this.commandExecutions.set(
      key,
      deepCopy({
        session_id: input.session_id,
        turn_id: input.turn_id,
        thread_id: input.event.thread_id,
        tool_call_id: input.event.tool_call_id,
        tool_name: input.event.tool_name,
        ...input.event.command_execution,
        status: 'running',
        disposition: null,
        owner_id: input.ownership.owner_id,
        lease_id: input.ownership.lease_id,
        lease_expires_at: input.ownership.lease_expires_at,
        started_at: new Date(input.event.created_at),
        completed_at: null,
      }),
    );
  }

  async appendCommandExecutionResult(input: AppendCommandExecutionResultInput): Promise<void> {
    this.requireRunningTurn(input.session_id, input.turn_id);
    const key = commandExecutionKey({
      session_id: input.session_id,
      turn_id: input.turn_id,
      thread_id: input.event.thread_id,
      tool_call_id: input.event.tool_call_id,
    });
    const execution = this.commandExecutions.get(key);
    if (execution?.status !== 'running' || execution.lease_id !== input.lease_id) {
      throw new SessionStoreInvariantError(`running command execution ${input.event.tool_call_id} not found`);
    }
    const eventList = this.events.get(turnKey(input));
    if (eventList === undefined) {
      throw new TurnNotFoundError(input.turn_id);
    }
    eventList.push(deepCopy(input.event));
    execution.status = 'terminal';
    execution.disposition = input.event.disposition;
    execution.completed_at = new Date(input.event.created_at);
  }

  async getCommandExecution(input: GetCommandExecutionInput): Promise<CommandExecutionRecord | undefined> {
    const record = this.commandExecutions.get(commandExecutionKey(input));
    return record === undefined ? undefined : deepCopy(record);
  }

  async renewCommandExecutionLease(input: RenewCommandExecutionLeaseInput): Promise<boolean> {
    const execution = this.commandExecutions.get(commandExecutionKey(input));
    if (execution?.status !== 'running' || execution.lease_id !== input.lease_id) {
      return false;
    }
    execution.lease_expires_at = new Date(input.lease_expires_at);
    return true;
  }

  async listRunningCommandExecutionOwnerIds(): Promise<string[]> {
    return [
      ...new Set(
        [...this.commandExecutions.values()]
          .filter(execution => execution.status === 'running')
          .map(execution => execution.owner_id),
      ),
    ].sort();
  }

  async recoverRunningCommandExecutions(input: RecoverRunningCommandExecutionsInput): Promise<number> {
    const selectedOwners = input.owner_ids === null ? undefined : new Set(input.owner_ids);
    let recovered = 0;
    for (const execution of this.commandExecutions.values()) {
      if (
        execution.status !== 'running' ||
        (selectedOwners !== undefined && !selectedOwners.has(execution.owner_id)) ||
        (input.require_expired_lease && execution.lease_expires_at > input.completed_at)
      ) {
        continue;
      }
      this.closeCommandExecution(execution, input.completed_at);
      recovered += 1;
    }
    return recovered;
  }

  private closeRunningCommandExecutions(sessionId: string, turnId: string, completedAt: Date): void {
    for (const execution of this.commandExecutions.values()) {
      if (execution.session_id !== sessionId || execution.turn_id !== turnId || execution.status !== 'running') {
        continue;
      }
      this.closeCommandExecution(execution, completedAt);
    }
  }

  private closeCommandExecution(execution: CommandExecutionRecord, completedAt: Date): void {
    execution.status = 'terminal';
    execution.disposition = 'outcome_unknown';
    execution.completed_at = new Date(completedAt);
    const eventList = this.events.get(turnKey(execution));
    eventList?.push(
      createToolResponseV2({
        id: newEventId(),
        thread_id: execution.thread_id,
        tool_call_id: execution.tool_call_id,
        created_at: completedAt.toISOString(),
        raw_content: JSON.stringify({
          error: 'The registered command owner stopped before a terminal provider result was persisted.',
        }),
        model_content: null,
        screen: null,
        disposition: 'outcome_unknown',
        remediation: {
          reason_code: 'execution_interrupted',
          message: 'Inspect the repository state before deciding whether the command is safe to retry.',
          suggested_action: 'inspect_state',
        },
        admission_provenance: { source: 'automatic' },
        memoized: false,
        repeat_count: 0,
      }).event,
    );
  }

  /** Cost from turn metrics when present; duration is completed_at − created_at, floored at 0. */
  private addTerminalSessionMetrics(sessionId: string, created_at: Date, state: TerminalTurnState): void {
    const stored = this.sessions.get(sessionKey(sessionId));
    if (!stored) {
      throw new SessionNotFoundError(sessionId);
    }
    const elapsed_ms = Date.parse(state.completed_at) - created_at.getTime();
    const turnCost = state.metrics?.total_cost_in_usd;
    if (turnCost !== undefined) {
      stored.record.metrics.total_cost_in_usd = (stored.record.metrics.total_cost_in_usd ?? 0) + turnCost;
    }
    stored.record.metrics.total_duration_ms += elapsed_ms > 0 ? Math.trunc(elapsed_ms) : 0;
  }

  private requireTurn(sessionId: string, turnId: string): TurnRecord<TTurnCustom> {
    const turn = this.turns.get(turnKey({ session_id: sessionId, turn_id: turnId }));
    if (!turn) {
      throw new TurnNotFoundError(turnId);
    }
    return turn;
  }

  private requireRunningTurn(sessionId: string, turnId: string): TurnRecord<TTurnCustom> {
    const turn = this.requireTurn(sessionId, turnId);
    if (turn.state.status !== 'running') {
      throw new TurnNotRunningError(turnId, turn.state);
    }
    return turn;
  }

  async addThreads(input: AddThreadsInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    for (const thread of input.threads) {
      turn.snapshot.threads[thread.thread_id] = deepCopy(thread);
    }
    turn.updated_at = new Date();
    return;
  }

  async addThreadsAndAppendEvents(input: AddThreadsAndAppendEventsInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    const events = this.events.get(turnKey(input));
    if (!events) {
      throw new TurnNotFoundError(input.turn_id);
    }
    for (const thread of input.threads) {
      turn.snapshot.threads[thread.thread_id] = deepCopy(thread);
    }
    events.push(...deepCopy(input.events));
    turn.updated_at = new Date();
  }

  async removeThreads(input: RemoveThreadsInput): Promise<void> {
    if (input.thread_ids.length === 0) {
      return;
    }
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    for (const id of input.thread_ids) {
      Reflect.deleteProperty(turn.snapshot.threads, id);
    }
    turn.updated_at = new Date();
    return;
  }

  async appendToThreadContext(input: AppendToThreadContextInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    const thread = turn.snapshot.threads[input.thread_id];
    if (!thread) {
      throw new SessionStoreInvariantError(`Thread not found: ${input.thread_id}`);
    }
    thread.context.push(...deepCopy(input.context));
    if (input.current_context_usage !== null) {
      thread.current_context_usage = deepCopy(input.current_context_usage);
    }
    if (input.completion !== null) {
      thread.completion = deepCopy(input.completion);
    }
    if (input.tool_call_memo !== undefined) {
      thread.tool_call_memo = deepCopy(input.tool_call_memo);
    }
    if (input.task_state !== undefined) {
      thread.task_state = deepCopy(input.task_state);
    }
    turn.updated_at = new Date();
    return;
  }

  async overwriteThreadContext(input: OverwriteThreadContextInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    const threadId = input.event.thread_id;
    const thread = turn.snapshot.threads[threadId];
    if (!thread) {
      throw new SessionStoreInvariantError(`Thread not found: ${threadId}`);
    }
    thread.context = deepCopy(input.event.context);
    thread.current_context_usage = deepCopy(input.event.current_context_usage);
    turn.updated_at = new Date();
    return;
  }

  async patchMCPServers(input: PatchMCPServersInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    turn.snapshot.mcp_servers ??= {};
    for (const server of input.mcp_servers) {
      turn.snapshot.mcp_servers[server.id] = deepCopy(server);
    }
    turn.updated_at = new Date();
    return;
  }

  async patchSandboxInfo(input: PatchSandboxInfoInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    turn.snapshot.sandbox_info = deepCopy(input.sandbox_info);
    turn.updated_at = new Date();
    return;
  }

  async patchThreadCapabilityState(input: PatchThreadCapabilityStateInput): Promise<void> {
    const turn = this.requireRunningTurn(input.session_id, input.turn_id);
    const thread = turn.snapshot.threads[input.thread_id];
    if (!thread) {
      throw new SessionStoreInvariantError(`Thread not found: ${input.thread_id}`);
    }
    thread.capability_state ??= {};
    if (input.state === null) {
      Reflect.deleteProperty(thread.capability_state, input.key);
      if (Object.keys(thread.capability_state).length === 0) {
        thread.capability_state = null;
      }
    } else {
      thread.capability_state[input.key] = deepCopy(input.state);
    }
    turn.updated_at = new Date();
    return;
  }

  async listTurnEvents(input: ListTurnEventsInput): Promise<{
    data: PersistedTurnEvent[];
    pagination: TokenPagination;
  }> {
    this.requireTurn(input.session_id, input.turn_id);
    const list = this.events.get(turnKey(input));
    if (!list) {
      throw new TurnNotFoundError(input.turn_id);
    }
    const ordered = [...list].sort((a, b) =>
      input.order === 'desc' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id),
    );
    const page = paginate(ordered, input.limit, input.page_token);
    return { data: deepCopy(page.data), pagination: page.pagination };
  }

  async listSessionEvents(input: ListSessionEventsInput): Promise<{
    data: SessionEventItem[];
    pagination: TokenPagination;
  }> {
    const stored = this.sessions.get(sessionKey(input.session_id));
    if (!stored) {
      throw new SessionNotFoundError(input.session_id);
    }

    const cursor = input.page_token === undefined ? undefined : decodeSessionEventPageToken(input.page_token);
    const lastTurnId = cursor?.last_turn_id ?? input.last_turn_id ?? stored.record.last_turn_id;
    if (lastTurnId === null) {
      return { data: [], pagination: { limit: input.limit } };
    }

    const anchor = this.turns.get(turnKey({ session_id: input.session_id, turn_id: lastTurnId }));
    if (!anchor) {
      throw new TurnNotFoundError(lastTurnId);
    }
    const window = sessionEventChainWindow({ chain: this.resolveAncestorChain(input.session_id, anchor), cursor });
    const types = input.types === undefined ? undefined : new Set<string>(input.types);
    const afterEventId = input.after_event_id;
    const keep = (turnId: string, event: PersistedTurnEvent): boolean => {
      if (cursor?.turn_id === turnId && event.id.localeCompare(cursor.event_id) >= 0) {
        return false;
      }
      if (afterEventId !== undefined && event.id.localeCompare(afterEventId) <= 0) {
        return false;
      }
      return types === undefined || types.has(event.type);
    };
    const rows: SessionEventItem[] = [];
    for (const turnId of [...window].reverse()) {
      const evts = this.events.get(turnKey({ session_id: input.session_id, turn_id: turnId })) ?? [];
      for (const event of [...evts].sort((a, b) => b.id.localeCompare(a.id))) {
        if (keep(turnId, event)) {
          rows.push({ turn_id: turnId, event });
        }
      }
      if (rows.length > input.limit) {
        break;
      }
    }
    const page = paginateSessionEventRows(rows, { limit: input.limit, last_turn_id: lastTurnId });
    return { data: deepCopy(page.data), pagination: page.pagination };
  }

  /**
   * Full chain (oldest first, anchor last). `ancestor_ids` may be only the
   * previous N ancestors, so spill through the oldest ancestor's own window
   * until a root or gap. A missing turn or repeated id ends the walk.
   */
  private resolveAncestorChain(sessionId: string, anchor: TurnRecord<TTurnCustom>): string[] {
    const chain = [...anchor.ancestor_ids, anchor.turn_id];
    const seen = new Set(chain);
    let oldestId = chain[0];
    while (oldestId && oldestId !== anchor.turn_id) {
      const oldest = this.turns.get(turnKey({ session_id: sessionId, turn_id: oldestId }));
      if (!oldest) {
        break;
      }
      const older = oldest.ancestor_ids.filter(id => !seen.has(id));
      if (older.length === 0) {
        break;
      }
      chain.unshift(...older);
      for (const id of older) {
        seen.add(id);
      }
      oldestId = older[0];
    }
    return chain;
  }
}
