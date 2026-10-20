/**
 * Public agent execution harness.
 * Intentional consumer-facing exports only (production API).
 */

// Runtime
export { HeldActionRefusedError } from './permissions/heldActions';
export type { HeldRefusalReason } from './permissions/heldActions';
export {
  AbnormalHandoffCauseSchema,
  mechanicalAbnormalHandoff,
  unavailableAbnormalHandoffEvidence,
} from './runtime/AbnormalHandoff';
export type {
  AbnormalHandoff,
  AbnormalHandoffCause,
  AbnormalHandoffEvidence,
  HandoffRepositoryBinding,
} from './runtime/AbnormalHandoff';
export type { AgentDefinition, ConfiguredModelSummary, ModelParams } from './runtime/AgentDefinition';
export { AgentThread } from './runtime/AgentThread';
export type {
  AgentInfo,
  AgentParent,
  AgentSendInput,
  AgentThreadAppendContext,
  AgentThreadCreateSubAgent,
  AgentThreadEvent,
  AgentThreadExecutionEvent,
  AgentThreadExecutionResult,
  SubAgentCompletionMarker,
} from './runtime/AgentThread.types';
export { AgentThreadOrchestrator } from './runtime/AgentThreadOrchestrator';
export { stageAttachment } from './runtime/attachmentStaging';
export type { StagedAttachment } from './runtime/attachmentStaging';
export { isHostWrappedText, isUntrustedDocumentText } from './runtime/contextUtils';
export type { CreateDynamicSubAgentThread } from './runtime/CreateDynamicSubAgentThread';
export {
  extractBase64,
  isAgentInputUserMessage,
  isEmptyMessageContent,
  isFileContentPart,
} from './runtime/UserInputMessage';
export type { AgentInputUserMessage } from './runtime/UserInputMessage';

// Deterministic local document extraction/report capability.
export type {
  DocumentExtraction,
  DocumentExtractionMode,
  DocumentInputFile,
  DocumentSource,
  DocumentTextLine,
  ExtractedDocument,
  ExtractedDocumentPage,
} from '../documents/documentExtraction';
export type { StructuredDocumentReport } from '../documents/documentRenderer';
export type { NetWorthObservationInput, NetWorthReport } from '../documents/netWorthReport';
export { DEFAULT_OCR_LANGUAGES, requiredOcrLanguages } from '../documents/ocrLanguages';
export {
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  DOCUMENTS_SERVER_ID,
  EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
  SUMMARIZE_NET_WORTH_TOOL_NAME,
  documentCapability,
} from './capabilities/builtins/DocumentTools';

// Capability contracts
export type { AgentCapability, CapabilityState, JsonValue } from './capabilities/AgentCapability';
export type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  PostToolCallAgentContextProcessor,
  PreLLMEphemeralAgentContextProcessor,
} from './capabilities/AgentContextProcessor';
export type { ToolResponseProcessor, ToolResponseProcessorResult } from './capabilities/ToolResponseProcessor';

// Built-in factories
export { getModelOutputExceedsContextError } from '../schemas/modelTokenLimits';
export { ToolOutputScreenDecisionSchema, ToolOutputScreenFailureReasonCodeSchema } from '../schemas/toolOutputScreen';
export type {
  ToolOutputScreenClassification,
  ToolOutputScreenDecision,
  ToolOutputScreenFailureReasonCode,
} from '../schemas/toolOutputScreen';
export { askUserQuestion } from './capabilities/builtins/AskUserQuestion';
export {
  CONVERSATION_COMPACTION_TEMPLATE,
  HOST_COMPACTION_TEMPLATE,
  HOST_SUMMARY_PREFACE,
  contextCompaction,
  replaceBoundRepositorySection,
  validateCompactionSummary,
} from './capabilities/builtins/ContextCompaction';
export type { CompactionSessionMode } from './capabilities/builtins/ContextCompaction';
export { currentDateTime } from './capabilities/builtins/CurrentDateTime';
export { SUB_AGENT_IDENTITY, dynamicSubAgents } from './capabilities/builtins/DynamicSubAgents';
export {
  DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD,
  DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS,
  DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD,
  jsonStructuralSummary,
  largeToolResponse,
} from './capabilities/builtins/LargeToolResponse';
export { openUI } from './capabilities/builtins/OpenUI';
export {
  REPLACE_TASK_CHECKLIST_TOOL_NAME,
  TASK_CHECKLIST_SERVER_ID,
  taskChecklist,
} from './capabilities/builtins/TaskChecklist';
export type { TaskChecklistAccess } from './capabilities/builtins/TaskChecklist';
export { TOKEN_BUDGET_SAFETY_MARGIN } from './capabilities/builtins/tokenBudgetConstants';
export { toolOutputScreen } from './capabilities/builtins/ToolOutputScreen';
export type { ToolOutputScreenClassifier } from './capabilities/builtins/ToolOutputScreen';
export {
  WEB_SEARCH_RENDER_MAX_RESULTS,
  renderWebSearchResultsMarkdown,
  webSearchRendering,
} from './capabilities/builtins/WebSearchRendering';
export { resolveLocalTime } from './util/clientTimezone';

// MCP contracts
export type { ApprovalDecision } from './events/schema';
export { ClientSideTool } from './mcp/ClientSideTool';
export { isAuthRequired, toolResultResponse } from './mcp/IMCPServer';
export type {
  AgentToolSchema,
  AuthRequiredResponse,
  CallToolResponse,
  IToolSet,
  ListToolsResponse,
  MCPAuthRequired,
  ToolSource,
} from './mcp/IMCPServer';
export { LocalToolMCP, defineTool } from './mcp/LocalToolMCP';
export type { ToolDefinition } from './mcp/LocalToolMCP';

// Remote MCP server, split into a shared, policy-free connection (`RemoteMCP`) and a per-agent policy
// wrapper (`ToolSet`). `RemoteMCP` connects itself from a `url` + `headers`; the networking helpers
// live in the harness-internal `remoteMcpClient` module.
export {
  IMPLEMENTATION_PLAN_GRANT_KIND,
  ImplementationPlanGrantSchema,
  ImplementationPlanSchema,
  implementationPlanAllowsCommand,
  implementationPlanAllowsPaths,
  implementationPlanAllowsScope,
  implementationPlanCheckoutId,
  isSerializedImplementationPlanGrant,
  mintImplementationPlanGrant,
  parseImplementationPlanGrant,
  serializeImplementationPlanGrant,
  validateImplementationPlanGrant,
} from './mcp/implementationPlanGrant';
export type {
  ImplementationPlan,
  ImplementationPlanBinding,
  ImplementationPlanCheckoutIdentityInput,
  ImplementationPlanGrant,
  ImplementationPlanGrantOwner,
  ImplementationPlanGrantScope,
} from './mcp/implementationPlanGrant';
export { RemoteMCP } from './mcp/RemoteMCP';
export type { RemoteMcpHeaders, ResolveHeadersResult } from './mcp/RemoteMCP';
export type { RemoteMcpConnection, RemoteMcpTransportType } from './mcp/remoteMcpClient';
export type { ToolSelectorConfig } from './mcp/ToolSelectorPolicy';
export {
  DEFAULT_DISABLE_TOOLS,
  DEFAULT_ENABLE_TOOLS,
  DEFAULT_PRELOAD_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS,
  REQUIRE_APPROVAL_TOOLS_SELECTOR_TAGS,
  TOOLS_SELECTOR_TAGS,
  TOOL_TAG_READ_ONLY,
} from './mcp/toolSelectors';
export { ToolSet } from './mcp/ToolSet';

// LLM contracts
export { isFailoverRetryable, withFailover } from './llm/failoverLanguageModel';
export type { FailoverLanguageModelOptions } from './llm/failoverLanguageModel';
export type { AgentMetadata, ILLM, LLMCreateParams, LLMCreateParamsStreaming } from './llm/ILLM';
export { ResponseFormatSchema, toOpenAIResponseFormat } from './llm/responseFormat';
export type { ResponseFormat } from './llm/responseFormat';
export {
  SUPPORTED_REASONING_EFFORTS,
  TOKEN_FACTORY_DEFAULT_BASE_URL,
  VERCEL_AI_PROVIDER_NAMES,
  VercelAILLM,
} from './llm/VercelAILLM';
export type { StreamTimeout, VercelAILLMConfig, VercelAIProviderConfig, VercelAIProviderName } from './llm/VercelAILLM';

// Event contracts
export {
  ActionRequiredEventSchema,
  AgentInputUserMessageSchema,
  ContextCompactionEventSchema,
  DocumentIngestionEventSchema,
  EventIdSchema,
  EventType,
  MCPAuthRequiredEventSchema,
  MCPInitializeEventSchema,
  ModelMessageDeltaEventSchema,
  ModelMessageEventSchema,
  SandboxCreatedEventSchema,
  ThreadCreatedEventSchema,
  ThreadDoneEventSchema,
  ThreadOverwriteContextEventSchema,
  ToolApprovalRequiredEventSchema,
  ToolExecutionStartedEventSchema,
  ToolOutputTransformSchema,
  ToolResponseEventSchema,
  ToolResponseEventV2Schema,
  ToolResponseRequiredEventSchema,
  UserToolApprovalMessageSchema,
  UserToolResponseMessageSchema,
  createToolResponseV2,
  newEventId,
} from './events/schema';
export type {
  AgentOutputEvent,
  ContextCompactionEvent,
  DocumentIngestionEvent,
  MCPAuthRequiredEvent,
  MCPServerAuthInfo,
  MCPServerInitInfo,
  ModelMessageEvent,
  ThreadDoneEvent,
  ThreadOverwriteContextEvent,
  ToolAdmissionProvenance,
  ToolExecutionStartedEvent,
  ToolOutputTransform,
  ToolResponseEventV2,
  ToolResultDisposition,
  ToolResultRemediation,
} from './events/schema';
export { CompletionUsageSchema } from './llm/LLMTypes';
export type { CompletionUsage, ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from './llm/LLMTypes';
export type { ChatCompletionContentPartRefusal, ChatCompletionContentPartText } from './llm/openaiSchemas';
export type { ToolCallMemoSnapshot, ToolCallResult } from './mcp/executeToolCalls';
export { InternalEventType } from './runtime/AgentThread.types';
export type { AgentThreadSendBatch, ContextMessage } from './runtime/AgentThread.types';
export { isInternalSystemMessage } from './runtime/contextUtils';
export { AgentThreadMetricsSchema } from './runtime/metrics';
export type { AgentThreadMetrics } from './runtime/metrics';
export { TaskFindingSchema, TaskPhaseSchema, TaskStateSchema } from './runtime/taskState';
export type { TaskFinding, TaskPhase, TaskState, TaskStateSnapshot } from './runtime/taskState';

// Tracing
export type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
} from './tracing/AgentTracing';

// Errors / utils
export {
  AgentHarnessError,
  ImplementationPlanAdmissionBlockedError,
  McpConnectionError,
  McpDcrConfigurationError,
  StructuredEditPreconditionBlockedError,
  ToolPolicyBlockedError,
  ToolPreDispatchError,
} from './errors';
export { REDIS_KEY_NAMESPACE, redisKey } from './redisKeys';
export { describeUnknownError, extractErrorLogFields } from './util/errorLogFields';
export { PromiseTimeoutError, withTimeout } from './util/promiseUtils';
export { isRedirectStatus, redirectTargetOrigin } from './util/redirects';

// Sandbox (concrete implementation; provider details exported for composition)
export { CodeModeDispatcher } from './sandbox/codeMode/CodeModeDispatcher';
export type { CodeModeLogger } from './sandbox/codeMode/CodeModeDispatcher';
export type { CodeModeClientInstall, CodeModeTransport } from './sandbox/codeMode/CodeModeTransport';
export { CodeModeErrorSourceSchema, CodeModeReplySchema, CodeModeRequestSchema } from './sandbox/codeMode/types';
export type { CodeModeErrorSource, CodeModeReply, CodeModeRequest } from './sandbox/codeMode/types';
export { SANDBOX_ALLOWED_EGRESS_DOMAINS, sandboxEgressDomainAllowList } from './sandbox/egressPolicy';
// run_code isolation-driver stack (Docker v1; Firecracker parked until /dev/kvm is confirmed)
export { DockerDriver } from './sandbox/driver/DockerDriver';
export type { DockerDriverOptions } from './sandbox/driver/DockerDriver';
export { errorCodeForTermination, errorTextForCode, scrubHostPaths } from './sandbox/driver/errors';
export { classifyExecCommand, interpreterInvocationRefusal } from './sandbox/driver/ExecGuard';
export type { ExecGuardHost, ExecGuardVerdict } from './sandbox/driver/ExecGuard';
export { OUTPUT_EXCEEDED_MARKER, RUN_CODE_RESERVED_PREFIX, runCodeProgramPath } from './sandbox/driver/IsolationDriver';
export type {
  DriverReadiness,
  DriverRunParams,
  DriverRunResult,
  DriverTermination,
  IsolationDriver,
  RunCodeLanguage,
  SandboxIdentity,
} from './sandbox/driver/IsolationDriver';
export {
  RUN_CODE_ERROR_CODES,
  RunCodeInputSchema,
  RunCodeResultSchema,
  RunCodeStatusSchema,
} from './sandbox/driver/RunCodeSchemas';
export type { RunCodeErrorCode, RunCodeInput, RunCodeResult, RunCodeStatus } from './sandbox/driver/RunCodeSchemas';
export { RunCodeService, validateRunCodeStartupConfig } from './sandbox/driver/RunCodeService';
export type {
  HarvestedFile,
  RunCodeCallOptions,
  RunCodeServiceOptions,
  TurnAttachment,
} from './sandbox/driver/RunCodeService';
export { runCodeStatusFromReadiness } from './sandbox/driver/runCodeStatus';
export { DisabledDriver } from './sandbox/driver/sandboxDisabled';
export { GIT_NETWORK_ENV_NAMES, pickGitNetworkEnv } from './sandbox/hostAuthenticatedGit';
export {
  PACKAGE_GIT_DEPENDENCY_MESSAGE,
  commandDownloadsPackages,
  findCommandLineGitDependency,
  findGitDependency,
} from './sandbox/packageMirrors';
export { DaytonaSandboxProvider } from './sandbox/provider/DaytonaProvider';
export type { DaytonaSandboxProviderOptions } from './sandbox/provider/DaytonaProvider';
export { absolutizeRelativeExecEnv } from './sandbox/provider/execEnv';
export {
  commandWithWorkspaceLock,
  ensureExecSuccess,
  executeVerifiedWorkspaceCommit,
  shellEscape,
  withTrustedPath,
  workspaceTerminationCommand,
} from './sandbox/provider/Provider';
export type {
  ExecErrorResult,
  ExecResult,
  ExecSuccessResult,
  SandboxBuild,
  SandboxBuildMetadata,
  SandboxBuildStatus,
  SandboxCreateParams,
  SandboxDownloadFileParams,
  SandboxExecParams,
  SandboxInit,
  SandboxProvider,
  SandboxUploadFileParams,
  VerifiedWorkspaceCommitParams,
  VerifiedWorkspaceCommitResult,
  WorkspaceTerminationParams,
  WorkspaceVerificationReceipt,
} from './sandbox/provider/Provider';
export { TFYSandboxProvider } from './sandbox/provider/TFYSandboxProvider';
export {
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  SKILL_DOWNLOAD_TIMEOUT_SECONDS,
  Sandbox,
  buildWriteAndRunScriptCommand,
} from './sandbox/Sandbox';
export type {
  BoundRepository,
  BoundRepositoryContext,
  RegisteredRepositoryCommand,
  RegisteredRepositoryCommandPurpose,
  RepositoryCommandSource,
  RepositoryCommandSourceKind,
  RepositoryCommandSourceObservation,
  RepositoryCommandSourceObserver,
  SandboxInfo,
  WorkspaceVerificationCoordinator,
} from './sandbox/Sandbox';
export { extractSandboxArtifactsFromMessage, parseSandboxArtifacts } from './sandbox/sandboxArtifacts';
export type { SandboxArtifact } from './sandbox/sandboxArtifacts';
export {
  SandboxError,
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  validateNoPathTraversal,
  validateSandboxOwnedByTenant,
} from './sandbox/SandboxErrors';
export { SANDBOX_IMAGE_URI } from './sandbox/sandboxImage';
export { existingSandboxIdForProvider, formatSandboxId, parseSandboxId, rawSandboxId } from './sandbox/sandboxRef';
export type { SandboxRefParts } from './sandbox/sandboxRef';
export { GitBridge } from './sandbox/slots/git/gitBridge';
export { execFileRunner } from './sandbox/slots/git/hostCommand';
export { probeSlotAttachments } from './sandbox/slots/slotAttachmentProbe';
export type { SlotAttachmentProbeResult } from './sandbox/slots/slotAttachmentProbe';
export {
  DEFAULT_SESSION_DISK_MB,
  SLOT_MIRROR_GUEST_PORT,
  SLOT_MIRROR_SOCKET_NAME,
  slotMirrorSocketPathsIn,
  slotSocketPathsIn,
} from './sandbox/slots/slotContract';
export { SLOT_FIX_COMMAND, SLOT_NOT_READY_MESSAGE, SlotDriver } from './sandbox/slots/SlotDriver';
export { SlotSandboxProvider } from './sandbox/slots/SlotSandboxProvider';
export { extractStructuredEditPaths, repositoryRootsMatch } from './sandbox/structuredEditPaths';
export type { StructuredEditPathRequest, StructuredEditPathResolution } from './sandbox/structuredEditPaths';

// Skills: the ISkillMounter seam lets hosts plug in their own skill sources
export { InstructionBuilder } from './InstructionBuilder';
export {
  SKILLS_PREAMBLE,
  SkillMounter,
  SkillPromptModeSchema,
  getSkillPath,
  renderSkillPromptBody,
} from './sandbox/skills';
export type { GitSkill, ISkillMounter, Skill, SkillMounterOptions, SkillPromptMode } from './sandbox/skills';

// Host tool-call policy: lets the host review model-authored tool calls before dispatch
export { applyHostToolCallPolicy } from './runtime/HostToolCallPolicy';
export type { HostToolCallPolicy, HostToolCallPolicyBlock, HostToolCallPolicyCall } from './runtime/HostToolCallPolicy';

// Sentinel: three-tier permission system for tool execution
export {
  InMemoryApprovalTokenStore,
  hasApprovalScope,
  hashApprovalTokenId,
  prepareApprovalToken,
  restoreApprovalToken,
} from './permissions/approvalTokens';
export type {
  ApprovalToken,
  ApprovalTokenRef,
  ApprovalTokenStore,
  ConnectorBinding,
  MintApprovalTokenInput,
  ShellApprovalBinding,
} from './permissions/approvalTokens';
export { recordClassificationAudit, recordHeldActionAudit } from './permissions/audit';
export type { AuditLogWriter, AuditOutcome, AuditRecordInput } from './permissions/audit';
export {
  canonicalShellForm,
  classifyHostToolCall,
  classifyTier,
  mapsDestinationHosts,
  shellBindingFromForm,
} from './permissions/classifier';
export type { ClassifyContext, SentinelAction } from './permissions/classifier';
export {
  DEFAULT_PINNED_PATH,
  classifyContextFor,
  createSentinelHostContext,
  defaultSentinelServices,
  toDispatchSentinelContext,
} from './permissions/context';
export type { SentinelCallIdentity, SentinelHostContext, SentinelServices } from './permissions/context';
export { verifyPreDispatch } from './permissions/dispatch';
export type { DispatchCheckContext, VerifiableCall } from './permissions/dispatch';
export {
  DEFAULT_MAPS_TRAVEL_MODE,
  MAPS_TRAVEL_MODES,
  MapsRouteResultSchema,
  MapsTransitStepSchema,
  MapsTravelModeSchema,
} from './permissions/mapsRouteSchemas';
export type {
  MapsRouteResult,
  MapsTransitStep,
  MapsTransitVehicle,
  MapsTravelMode,
} from './permissions/mapsRouteSchemas';
export {
  MAPS_TOOL_NAMES,
  RENDER_MAP_TOOL_NAME,
  RENDER_PLACES_TOOL_NAME,
  RENDER_ROUTE_TOOL_NAME,
  isMapsToolName,
} from './permissions/mapsToolNames';
export { checkOutboundStrings, collectOutboundStrings } from './permissions/outboundGuard';
export type { OutboundGuardRule, OutboundGuardVerdict } from './permissions/outboundGuard';
export {
  AUTO_DENY_REASONS,
  TIER2_ACTION_KINDS,
  Tier3CardSchema,
  TierSchema,
  autoDenyDecision,
  failClosedDecision,
  tier1Decision,
  tier2Decision,
  tier3Decision,
} from './permissions/tier';
export type {
  AutoDenyReason,
  Tier,
  Tier2ActionKind,
  Tier3Card,
  Tier3Schedule,
  TierDecision,
  TrackedExecutionBinding,
} from './permissions/tier';
export type { ToolGrantIdentity, ToolGrantKey, ToolGrantStore } from './permissions/toolGrants';
export {
  SILENT_SEARCH_LIMIT,
  createWebSearchTurnState,
  recordResultUrls,
  remoteImageAskReason,
} from './permissions/webSearch';
export type { SearchProviderGrant, WebSearchTurnState } from './permissions/webSearch';
export { FETCHED_PAGE_TEXT_MAX_CHARS, FetchedPageStore, fetchedPages, recordFetchedPages } from './search/fetchedPages';
export type { FetchedPageScope } from './search/fetchedPages';
export { groundPlace, isInCalendar, normalizedWords } from './search/groundPlace';
export type { GroundedPlace, PlaceClaim } from './search/groundPlace';
