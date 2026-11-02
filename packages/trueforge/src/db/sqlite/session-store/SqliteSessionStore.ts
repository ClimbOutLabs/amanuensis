import type { SessionFolderRecord } from '@truefoundry/trueforge-core/agent-session/models/SessionFolderRecord';
import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session/models/SessionRecord';
import type { TurnRecord } from '@truefoundry/trueforge-core/agent-session/models/TurnRecord';
import type { PersistedTurnEvent, SessionEventItem } from '@truefoundry/trueforge-core/agent-session/schemas/events';
import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session/schemas/pagination';
import type { TaskChecklist } from '@truefoundry/trueforge-core/agent-session/schemas/taskChecklist';
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
  ChatSearchHit,
  ClearChatSearchIndexInput,
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
  ISessionStore,
  IndexChatMessagesInput,
  ListApprovalDismissalsInput,
  ListImplementationPlanGrantsInput,
  ListSessionEventsInput,
  ListSessionFoldersInput,
  ListSessionsInput,
  ListTurnEventsInput,
  ListTurnsInput,
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
  TurnRecordWithoutSnapshot,
  UpdateSessionFolderInput,
  UpdateSessionInput,
  UpdateTurnStateInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  decodeOffsetPageToken,
  encodeOffsetPageToken,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import type { ImplementationPlanGrant } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import type { AppendPassthroughEventsInput, ICompletedTurnEventStore } from '../../completedTurnEvents';
import type { SessionCustom, TurnCustom } from '../../sessionCustom';
import type { Database } from '../types';
import {
  listApprovalDismissals as listApprovalDismissalsQuery,
  recordApprovalDismissal as recordApprovalDismissalQuery,
} from './queries/approvalDismissals';
import { patchThreadCapabilityState as patchThreadCapabilityStateQuery } from './queries/capabilities';
import {
  clearChatSearchIndex as clearChatSearchIndexQuery,
  indexChatMessages as indexChatMessagesQuery,
  searchChatHistory as searchChatHistoryQuery,
} from './queries/chatSearch';
import {
  appendCommandExecutionResult as appendCommandExecutionResultQuery,
  appendCommandExecutionStarted as appendCommandExecutionStartedQuery,
  getCommandExecution as getCommandExecutionQuery,
  listRunningCommandExecutionOwnerIds as listRunningCommandExecutionOwnerIdsQuery,
  recoverRunningCommandExecutions as recoverRunningCommandExecutionsQuery,
  renewCommandExecutionLease as renewCommandExecutionLeaseQuery,
} from './queries/commandExecutions';
import {
  appendEventsToDoneTurn as appendEventsToDoneTurnQuery,
  appendToEvents as appendToEventsQuery,
  listSessionEvents as listSessionEventsQuery,
  listTurnEvents as listTurnEventsQuery,
} from './queries/events';
import {
  beginImplementationPlanDispatch as beginImplementationPlanDispatchQuery,
  completeImplementationPlanDispatch as completeImplementationPlanDispatchQuery,
  listImplementationPlanGrants as listImplementationPlanGrantsQuery,
  persistImplementationPlanGrant as persistImplementationPlanGrantQuery,
  revokeImplementationPlanGrant as revokeImplementationPlanGrantQuery,
} from './queries/implementationPlanGrants';
import {
  createSessionFolder as createSessionFolderQuery,
  deleteSessionFolder as deleteSessionFolderQuery,
  getSessionFolder as getSessionFolderQuery,
  listSessionFolders as listSessionFoldersQuery,
  setSessionFolder as setSessionFolderQuery,
  updateSessionFolder as updateSessionFolderQuery,
} from './queries/sessionFolders';
import {
  createSession as createSessionQuery,
  deleteSession as deleteSessionQuery,
  getOwnedIds as getOwnedIdsQuery,
  getSessionByExternalId as getSessionByExternalIdQuery,
  getSession as getSessionQuery,
  listSessions as listSessionsQuery,
  stampImportedSession as stampImportedSessionQuery,
  updateSession as updateSessionQuery,
} from './queries/sessions';
import {
  getTaskChecklist as getTaskChecklistQuery,
  replaceTaskChecklist as replaceTaskChecklistQuery,
} from './queries/taskChecklist';
import {
  addThreadsAndAppendEvents as addThreadsAndAppendEventsQuery,
  addThreads as addThreadsQuery,
  appendToThreadContext as appendToThreadContextQuery,
  overwriteThreadContext as overwriteThreadContextQuery,
  patchMCPServers as patchMCPServersQuery,
  patchSandboxInfo as patchSandboxInfoQuery,
  removeThreads as removeThreadsQuery,
} from './queries/threads';
import type { NewThreadRegistration } from './queries/turns';
import {
  createTurn as createTurnQuery,
  freezeAndGetTurn as freezeAndGetTurnQuery,
  getTurn as getTurnQuery,
  listTurns as listTurnsQuery,
  updateTurnState as updateTurnStateQuery,
} from './queries/turns';

/**
 * ## Design: append-only context log + per-turn position table
 *
 * Message bodies live in `thread_context_log`, append-only, written exactly
 * once; ids are SQLite AUTOINCREMENT (`append_id`). A turn's context per thread
 * is ordered rows in `turn_thread_context (pos, append_id)` — no array column.
 * Turns share no mutable structure: linear continuation and fork are the same
 * copy path (parent context mapping rows + new mapping rows), overwrite deletes
 * the current mapping and inserts a fresh one, and a still-running ancestor's
 * late appends touch only its OWN rows — structural leaks are impossible.
 *
 * Hard invariants:
 * 1. A turn cannot be used as `previous_turn_id` while it is still `running` —
 *    `createTurn` rejects that; callers must `freezeAndGetTurn` first.
 *    Tip-equality is NOT required: new roots and concurrent forks from a
 *    finished tip can leave more than one turn `running` at once.
 * 2. Every turn-scoped write is fenced on `state->>'status' = 'running'`.
 * 3. Terminal turns are IMMUTABLE: a terminal read is a final read. One
 *    narrow exception: `appendEventsToDoneTurn` (db/completedTurnEvents.ts)
 *    may add passthrough audit rows to a `done` turn's event log.
 * 4. BEGIN IMMEDIATE provides write locking (no FOR SHARE / FOR UPDATE).
 */
export class SqliteSessionStore implements ISessionStore<SessionCustom, TurnCustom>, ICompletedTurnEventStore {
  constructor(private readonly db: Kysely<Database>) {}

  createSession(input: CreateSessionInput<SessionCustom>): Promise<void> {
    return createSessionQuery(this.db, input);
  }

  stampImportedSession(input: StampImportedSessionInput): Promise<void> {
    return stampImportedSessionQuery(this.db, input);
  }

  deleteSession(input: DeleteSessionInput): Promise<void> {
    return deleteSessionQuery(this.db, input);
  }

  listImplementationPlanGrants(input: ListImplementationPlanGrantsInput): Promise<ImplementationPlanGrant[]> {
    return listImplementationPlanGrantsQuery(this.db, input);
  }

  persistImplementationPlanGrant(input: PersistImplementationPlanGrantInput): Promise<void> {
    return persistImplementationPlanGrantQuery(this.db, input);
  }

  revokeImplementationPlanGrant(
    input: RevokeImplementationPlanGrantInput,
  ): Promise<RevokeImplementationPlanGrantResult> {
    return revokeImplementationPlanGrantQuery(this.db, input);
  }

  beginImplementationPlanDispatch(
    input: BeginImplementationPlanDispatchInput,
  ): Promise<BeginImplementationPlanDispatchResult> {
    return beginImplementationPlanDispatchQuery(this.db, input);
  }

  completeImplementationPlanDispatch(input: CompleteImplementationPlanDispatchInput): Promise<void> {
    return completeImplementationPlanDispatchQuery(this.db, input);
  }

  getSession(input: GetSessionInput): Promise<SessionRecord<SessionCustom> | undefined> {
    return getSessionQuery(this.db, input);
  }

  getTaskChecklist(input: GetTaskChecklistInput): Promise<TaskChecklist> {
    return getTaskChecklistQuery(this.db, input);
  }

  replaceTaskChecklist(input: ReplaceTaskChecklistInput): Promise<TaskChecklist> {
    return replaceTaskChecklistQuery(this.db, input);
  }

  getOwnedIds(input: GetOwnedIdsInput): Promise<readonly string[]> {
    return getOwnedIdsQuery(this.db, input);
  }

  getSessionByExternalId(input: GetSessionByExternalIdInput): Promise<SessionRecord<SessionCustom> | undefined> {
    return getSessionByExternalIdQuery(this.db, input);
  }

  updateSession(input: UpdateSessionInput<SessionCustom>): Promise<void> {
    return updateSessionQuery(this.db, input);
  }

  createSessionFolder(input: CreateSessionFolderInput): Promise<SessionFolderRecord> {
    return createSessionFolderQuery(this.db, input);
  }

  getSessionFolder(input: GetSessionFolderInput): Promise<SessionFolderRecord | undefined> {
    return getSessionFolderQuery(this.db, input);
  }

  listSessionFolders(input: ListSessionFoldersInput): Promise<SessionFolderRecord[]> {
    return listSessionFoldersQuery(this.db, input);
  }

  updateSessionFolder(input: UpdateSessionFolderInput): Promise<SessionFolderRecord | undefined> {
    return updateSessionFolderQuery(this.db, input);
  }

  deleteSessionFolder(input: DeleteSessionFolderInput): Promise<void> {
    return deleteSessionFolderQuery(this.db, input);
  }

  recordApprovalDismissal(input: RecordApprovalDismissalInput): Promise<void> {
    return recordApprovalDismissalQuery(this.db, input);
  }

  listApprovalDismissals(input: ListApprovalDismissalsInput): Promise<ApprovalDismissalRecord[]> {
    return listApprovalDismissalsQuery(this.db, input);
  }

  indexChatMessages(input: IndexChatMessagesInput): Promise<void> {
    return indexChatMessagesQuery(this.db, input);
  }

  searchChatHistory(input: SearchChatHistoryInput): Promise<ChatSearchHit[]> {
    return searchChatHistoryQuery(this.db, input);
  }

  clearChatSearchIndex(input: ClearChatSearchIndexInput): Promise<void> {
    return clearChatSearchIndexQuery(this.db, input);
  }

  setSessionFolder(input: SetSessionFolderInput): Promise<void> {
    return setSessionFolderQuery(this.db, input);
  }

  async listSessions(
    input: ListSessionsInput,
  ): Promise<{ data: SessionRecord<SessionCustom>[]; pagination: TokenPagination }> {
    const result = await listSessionsQuery(this.db, input);
    return {
      data: result.data,
      pagination: {
        limit: input.limit,
        ...result.pagination,
      },
    };
  }

  async createTurn(input: CreateTurnInput<TurnCustom>): Promise<void> {
    await createTurnQuery(this.db, {
      session_id: input.turn.session_id,
      approval_grants: input.approval_grants,
      require_previous_turn_is_tip: input.require_previous_turn_is_tip,
      retained_previous_thread_ids: input.retained_previous_thread_ids,
      turn: {
        turn_id: input.turn.turn_id,
        first_turn_id: input.turn.first_turn_id,
        previous_turn_id: input.turn.previous_turn_id,
        ancestor_ids: input.turn.ancestor_ids,
        input: input.turn.input,
        state: input.turn.state,
        custom: input.turn.custom,
      },
      new_threads: input.new_threads.map((thread): NewThreadRegistration => ({
        thread_id: thread.thread_id,
        parent: thread.parent,
        agent_info: thread.agent_info,
        tool_call_memo: thread.tool_call_memo,
        task_state: thread.task_state,
      })),
      new_context_appends: input.new_context_appends,
      capability_states: input.capability_states,
      tool_call_memos: input.tool_call_memos,
      task_states: input.task_states,
      last_activity_timestamp_ms: Date.now(),
      update_session_title_if_not_exist: input.update_session_title_if_not_exist,
      mcp_servers: null,
      sandbox_info: input.sandbox_info,
    });
  }

  freezeAndGetTurn(input: FreezeAndGetTurnInput): Promise<TurnRecord<TurnCustom>> {
    return freezeAndGetTurnQuery(this.db, input);
  }

  getTurn(input: GetTurnInput): Promise<TurnRecord<TurnCustom> | undefined> {
    return getTurnQuery(this.db, input);
  }

  async listTurns(
    input: ListTurnsInput,
  ): Promise<{ data: TurnRecordWithoutSnapshot<TurnCustom>[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const result = await listTurnsQuery(this.db, {
      session_id: input.session_id,
      limit: input.limit,
      offset,
    });
    const pagination: TokenPagination = { limit: input.limit };
    if (result.next_offset !== null) {
      pagination.next_page_token = encodeOffsetPageToken(result.next_offset);
    }
    if (offset > 0) {
      pagination.previous_page_token = encodeOffsetPageToken(Math.max(0, offset - input.limit));
    }
    return { data: result.turns, pagination };
  }

  updateTurnState(input: UpdateTurnStateInput): Promise<void> {
    return updateTurnStateQuery(this.db, input);
  }

  appendToEvents(input: AppendToEventsInput): Promise<void> {
    return appendToEventsQuery(this.db, input);
  }

  appendEventsToDoneTurn(input: AppendPassthroughEventsInput): Promise<void> {
    return appendEventsToDoneTurnQuery(this.db, input);
  }

  appendCommandExecutionStarted(input: AppendCommandExecutionStartedInput): Promise<void> {
    return appendCommandExecutionStartedQuery(this.db, input);
  }

  appendCommandExecutionResult(input: AppendCommandExecutionResultInput): Promise<void> {
    return appendCommandExecutionResultQuery(this.db, input);
  }

  getCommandExecution(input: GetCommandExecutionInput): Promise<CommandExecutionRecord | undefined> {
    return getCommandExecutionQuery(this.db, input);
  }

  renewCommandExecutionLease(input: RenewCommandExecutionLeaseInput): Promise<boolean> {
    return renewCommandExecutionLeaseQuery(this.db, input);
  }

  listRunningCommandExecutionOwnerIds(): Promise<string[]> {
    return listRunningCommandExecutionOwnerIdsQuery(this.db);
  }

  recoverRunningCommandExecutions(input: RecoverRunningCommandExecutionsInput): Promise<number> {
    return recoverRunningCommandExecutionsQuery(this.db, input);
  }

  addThreads(input: AddThreadsInput): Promise<void> {
    return addThreadsQuery(this.db, input);
  }

  addThreadsAndAppendEvents(input: AddThreadsAndAppendEventsInput): Promise<void> {
    return addThreadsAndAppendEventsQuery(this.db, input);
  }

  removeThreads(input: RemoveThreadsInput): Promise<void> {
    return removeThreadsQuery(this.db, input);
  }

  appendToThreadContext(input: AppendToThreadContextInput): Promise<void> {
    return appendToThreadContextQuery(this.db, input);
  }

  overwriteThreadContext(input: OverwriteThreadContextInput): Promise<void> {
    return overwriteThreadContextQuery(this.db, input);
  }

  patchMCPServers(input: PatchMCPServersInput): Promise<void> {
    return patchMCPServersQuery(this.db, input);
  }

  patchSandboxInfo(input: PatchSandboxInfoInput): Promise<void> {
    return patchSandboxInfoQuery(this.db, input);
  }

  patchThreadCapabilityState(input: PatchThreadCapabilityStateInput): Promise<void> {
    return patchThreadCapabilityStateQuery(this.db, input);
  }

  listTurnEvents(input: ListTurnEventsInput): Promise<{ data: PersistedTurnEvent[]; pagination: TokenPagination }> {
    return listTurnEventsQuery(this.db, input);
  }

  listSessionEvents(input: ListSessionEventsInput): Promise<{ data: SessionEventItem[]; pagination: TokenPagination }> {
    return listSessionEventsQuery(this.db, input);
  }
}
