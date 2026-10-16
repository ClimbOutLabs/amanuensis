/**
 * Public agent session middle library.
 * Zod product contracts and session/turn runtime.
 */

export { AgentSpecSchema, DEFAULT_AGENT_CONFIG_ITERATION_LIMIT, RuntimeConfigSchema } from './schemas/agentSpec';
export type { AgentSpec, Skill } from './schemas/agentSpec';

export {
  CancellationReason,
  CreateTurnRequestSchema,
  TurnInputItemSchema,
  TurnMetricsSchema,
  TurnSchema,
  TurnStateCancelledReasonSchema,
  TurnStateCancelledSchema,
  TurnStateDoneSchema,
  TurnStateErrorSchema,
  TurnStateRunningSchema,
  TurnStateSchema,
} from './schemas/turn';
export type { TerminalTurnState, Turn, TurnInputItem, TurnMetrics, TurnState } from './schemas/turn';

export {
  SessionAgentInlineSchema,
  SessionAgentSchema,
  SessionMetadataSchema,
  SessionMetricsSchema,
  SessionSchema,
  SessionSourceScheduleSchema,
  SessionSourceSchema,
  SessionSourceTypeSchema,
} from './schemas/session';
export type {
  Session,
  SessionAgent,
  SessionAgentInline,
  SessionMetadata,
  SessionMetrics,
  SessionSource,
  SessionSourceType,
} from './schemas/session';

export { CreatedBySubjectSchema } from './schemas/subject';
export type { CreatedBySubject } from './schemas/subject';

export {
  MAX_TASK_CHECKLIST_ITEMS,
  ReplaceTaskChecklistRequestSchema,
  TaskChecklistSchema,
  emptyTaskChecklist,
  parseStoredTaskChecklist,
} from './schemas/taskChecklist';
export type { ReplaceTaskChecklistRequest, TaskChecklist, TaskChecklistItem } from './schemas/taskChecklist';

export {
  EventType,
  SessionEventItemSchema,
  SessionEventSchema,
  TurnCreatedEventSchema,
  TurnDoneEventSchema,
} from './schemas/events';
export type {
  PersistedTurnEvent,
  SessionEvent,
  SessionEventItem,
  TurnCreatedEvent,
  TurnDoneEvent,
} from './schemas/events';

export { TokenPaginationSchema } from './schemas/pagination';
export type { TokenPagination } from './schemas/pagination';

export type { SessionFolderRecord } from './models/SessionFolderRecord';
export type { SessionRecord } from './models/SessionRecord';
export { MAIN_THREAD_ID } from './models/TurnRecord';
export type { TurnRecord, TurnSnapshot } from './models/TurnRecord';

export { assertCreateTurnThreadDelta } from './store/assertCreateTurnThreadDelta';
export { InMemorySessionStore } from './store/InMemorySessionStore';
export type {
  AddThreadsInput,
  AppendCommandExecutionResultInput,
  AppendCommandExecutionStartedInput,
  AppendToEventsInput,
  AppendToThreadContextInput,
  BeginImplementationPlanDispatchInput,
  BeginImplementationPlanDispatchResult,
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
  RecoverRunningCommandExecutionsInput,
  RemoveThreadsInput,
  ReplaceTaskChecklistInput,
  RevokeImplementationPlanGrantInput,
  RevokeImplementationPlanGrantResult,
  SetSessionFolderInput,
  TurnContextAppend,
  TurnRecordWithoutSnapshot,
  UpdateSessionFolderInput,
  UpdateSessionInput,
  UpdateTurnStateInput,
} from './store/ISessionStore';
export {
  ImplementationPlanGrantLifecycleError,
  InvalidPageTokenError,
  PreviousTurnRunningError,
  SessionAlreadyExistsError,
  SessionExternalIdConflictError,
  SessionFolderNotFoundError,
  SessionNotFoundError,
  SessionStoreConflictError,
  SessionStoreInvariantError,
  SessionStoreNotFoundError,
  StaleApprovalContinuationError,
  StaleTaskChecklistError,
  TurnAlreadyExistsError,
  TurnNotFoundError,
  TurnNotRunningError,
} from './store/SessionStoreErrors';

export type { ITurnResourceResolver, ResolvedAgentDefinition } from './ITurnResourceResolver';
export { TurnResourceResolver } from './TurnResourceResolver';
export type { TurnSandboxFactory } from './TurnResourceResolver';

export { SessionHandle, abnormalHandoffCauseForCancellation } from './SessionHandle';
export type { ApprovalResubmission } from './SessionHandle';
export { Sessions } from './Sessions';
export { TurnHandle } from './TurnHandle';
export type { TurnStreamingEvent } from './TurnHandle';
