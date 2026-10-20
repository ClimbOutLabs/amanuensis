/**
 * The two standard personal-instance configurations the prompt report measures: web search, maps,
 * spaces, schedules and memory, with and without a connected Google login.
 *
 * The host's own resolver and capabilities build the tools, so their schemas and instruction text
 * are the real ones. Stand-ins sit only where they do not change either: stores and the sandbox
 * provider are never called while a request is measured.
 */
import { AgentSpecSchema, threadCapabilities, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import { measurePromptRequest, type PromptReport } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord, GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { ILLM } from '@truefoundry/trueforge-core/core/llm/ILLM';
import type { SearchProviderGrant } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger, type Logger } from 'winston';
import type { IScheduleStore } from '../../db/scheduleStore';
import type { ChatAssistant } from '../chatAssistant';
import type { MemoryConfig } from '../memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceTurnContext } from '../spaceCapability';

export type PersonalInstanceName = 'personal' | 'personal-with-google';

const MODEL_NAME = 'personal/model';
const WEB_SEARCH_SERVER = 'web-search';
const WEB_SEARCH_URL = 'https://mcp.tavily.com/mcp/';
const TENANT_ID = 'prompt-report';
const CREATED_BY = 'prompt-report-user';
const SESSION_ID = 'prompt-report-session';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: false, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};

const TOOL_OUTPUT_SCREEN: ToolOutputScreenConfig = {
  enabled: false,
  url: '',
  authToken: '',
  threshold: 0.5,
  timeoutMs: 1500,
};

function unused(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not called while a prompt is measured`));
}

function unusedSync(name: string): never {
  throw new Error(`${name} is not called while a prompt is measured`);
}

/** Never called: the measurement only reads what the thread sends. */
const UNUSED_MODEL: ILLM = {
  create: () => {
    throw new Error('The prompt report never streams a completion.');
  },
  createNonStream: () => unused('model completion'),
};

function unusedSpaceStore(): SpaceTurnContext['store'] {
  return {
    createSpace: () => unused('createSpace'),
    updateSpace: () => unused('updateSpace'),
    revertSpace: () => unused('revertSpace'),
    listSpacesWithAggregate: () => unused('listSpacesWithAggregate'),
    getSpace: () => unused('getSpace'),
    getSpaceRevision: () => unused('getSpaceRevision'),
  };
}

function connectedGoogleStore(): GoogleConnectionStore {
  const record: GoogleConnectionRecord = {
    tenant_id: TENANT_ID,
    created_by: CREATED_BY,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client_id: 'prompt-report-client',
    client_secret: 'prompt-report-secret',
    client_type: 'web',
    refresh_token: 'prompt-report-refresh',
    granted_scopes: GOOGLE_SCOPES,
    account_email: null,
    status: 'connected',
  };
  return {
    get: () => Promise.resolve(record),
    save: () => unused('save'),
    markNeedsReconnect: () => unused('markNeedsReconnect'),
    setAccountEmail: () => unused('setAccountEmail'),
    delete: () => unused('delete'),
  };
}

function unusedScheduleStore(): IScheduleStore<unknown> {
  return {
    getSchedule: () => unused('getSchedule'),
    getScheduleForUpdate: () => unused('getScheduleForUpdate'),
    createScheduleAndRun: () => unused('createScheduleAndRun'),
    updateScheduleAndRun: () => unused('updateScheduleAndRun'),
    deleteSchedule: () => unused('deleteSchedule'),
    listSchedules: () => unused('listSchedules'),
    getOwnedIds: () => unused('getOwnedIds'),
    getRun: () => unused('getRun'),
    getRunById: () => unused('getRunById'),
    getScheduledRunFor: () => unused('getScheduledRunFor'),
    createRun: () => unused('createRun'),
    updateRunStatus: () => unused('updateRunStatus'),
    listScheduledRuns: () => unused('listScheduledRuns'),
    listRuns: () => unused('listRuns'),
  };
}

/** Schedules mount only where they run; the schedule tools are built from this context. */
function scheduleContext(logger: Logger): NonNullable<SpaceTurnContext['schedules']> {
  const assistant: ChatAssistant = {
    display_name: 'Assistant',
    persona_id: null,
    approval_key: 'prompt-report',
    agent: () => unused('agent'),
  };
  return {
    store: unusedScheduleStore(),
    withTransaction: () => unused('withTransaction'),
    tenant_id: TENANT_ID,
    owner: { subject_id: CREATED_BY, subject_type: 'user', subject_display_name: 'Prompt report' },
    chatAssistant: assistant,
    runsAs: () => Promise.resolve('you'),
    logger,
  };
}

function sandboxProvider(): SandboxProvider {
  return {
    type: 'prompt-report',
    buildImage: () => unused('buildImage'),
    getImageBuildStatus: () => unused('getImageBuildStatus'),
    acknowledgeWorkspaceTermination: () => unused('acknowledgeWorkspaceTermination'),
    executeVerifiedWorkspaceCommit: () => unused('executeVerifiedWorkspaceCommit'),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/skill_downloader.py`,
    downloadFile: () => unused('downloadFile'),
    uploadFile: () => unused('uploadFile'),
    createCodeModeTransport: () => unusedSync('createCodeModeTransport'),
    createSandbox: () => unused('createSandbox'),
    exec: () => unused('exec'),
  };
}

/** The web search connector as the host describes it: its URL, and the tools it designates as search. */
function webSearchConnector(): { url: string; headers: Record<string, string>; search_provider: SearchProviderGrant } {
  return {
    url: WEB_SEARCH_URL,
    headers: { Authorization: 'Bearer prompt-report' },
    search_provider: { tools: ['tavily_search', 'tavily_extract'], plumbing_fields: [] },
  };
}

function personalSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: MODEL_NAME },
    instructions: '',
    config: { sandbox: { enabled: true } },
    mcp_servers: [{ name: WEB_SEARCH_SERVER }],
  });
}

/**
 * Measures one standard configuration. The resolver assembles the host capabilities exactly as a turn does;
 * the web search tools come from the search connector's own tool source, which the host also mounts per turn.
 */
export async function measurePersonalInstance(input: { name: PersonalInstanceName }): Promise<PromptReport> {
  const logger = createLogger({ silent: true });
  const tracing = NOOP_AGENT_TRACING;
  const sandbox = new Sandbox({
    provider: sandboxProvider(),
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger,
    tracing,
  });
  const memory: MemoryTurnContext = {
    client: undefined,
    config: MEMORY_CONFIG,
    sessionId: SESSION_ID,
    previousTurnId: null,
    sessionTitle: undefined,
    providerServerName: undefined,
  };
  const space: SpaceTurnContext = {
    store: unusedSpaceStore(),
    authority: { tenantId: TENANT_ID, userRef: CREATED_BY },
    sessionId: SESSION_ID,
    logger,
    googleConnections: input.name === 'personal-with-google' ? connectedGoogleStore() : undefined,
    schedules: scheduleContext(logger),
  };
  const resolver = new SpaceTurnResourceResolver(
    {
      llm: () =>
        Promise.resolve({
          modelClient: UNUSED_MODEL,
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => (name === WEB_SEARCH_SERVER ? Promise.resolve(webSearchConnector()) : unused('mcp connection')),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger,
    },
    undefined,
    undefined,
    memory,
    TOOL_OUTPUT_SCREEN,
    undefined,
    undefined,
    undefined,
    space,
    {
      store: { recordStoredArtifact: () => unused('recordStoredArtifact') },
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      turnId: 'prompt-report-turn',
      logger,
    },
  );
  const spec = personalSpec();
  const resolved = await resolver.resolveAgentDefinition({
    spec,
    tenant_id: TENANT_ID,
    created_by: CREATED_BY,
    session_id: SESSION_ID,
    signal: new AbortController().signal,
    tracing,
  });
  const definition = resolved.definition;
  const capabilities = threadCapabilities({
    spec,
    definition,
    compactionModel: resolved.compactionModel,
    isChild: false,
    sandbox,
    sandboxAvailable: true,
    tracing,
    logger,
    extraCapabilities: resolved.extraCapabilities,
  });
  return measurePromptRequest({ definition, capabilities, sandbox });
}
