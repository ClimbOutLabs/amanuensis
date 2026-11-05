/**
 * The two standard personal-instance configurations the prompt report measures: web search, maps,
 * spaces, schedules and memory, with and without a connected Google login.
 *
 * The host's own resolver and capabilities build the tools, so their schemas and instruction text
 * are the real ones. Stand-ins sit only where they do not change either: stores and the sandbox
 * provider are never called while a request is measured.
 */
import {
  AgentSpecSchema,
  threadCapabilities,
  type AgentSpec,
  type ResolvedAgentDefinition,
} from '@truefoundry/trueforge-core/agent-session';
import { measurePromptRequest, type PromptReport } from '@truefoundry/trueforge-core/core';
import type { AgentCapability } from '@truefoundry/trueforge-core/core/capabilities/AgentCapability';
import type { GoogleConnectionRecord, GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { ILLM } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  createSentinelHostContext,
  type SentinelHostContext,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core/permissions/context';
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
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import type { UsageSessionReader } from '../usageSummaryCapability';

export type PersonalInstanceName =
  'personal' | 'personal-with-google' | 'personal-no-sandbox' | 'personal-no-server-sandbox';

/** Every standard setup the report measures, in report order. */
export const PERSONAL_INSTANCE_NAMES = [
  'personal',
  'personal-with-google',
  'personal-no-sandbox',
  'personal-no-server-sandbox',
] satisfies PersonalInstanceName[];

export type PromptReportTurn = 'core-only' | 'calendar' | 'web';

/** Typical turns, each a message the person sends; every turn sends the same prompt and tools. */
export const PROMPT_REPORT_TURNS: Record<PromptReportTurn, string> = {
  'core-only': 'Thanks, that is all for now.',
  calendar: 'Add a reminder to my calendar for Thursday at 9:00: dentist.',
  web: "Search the web for this week's opening hours of the Lisbon Oceanarium.",
};

export const PROMPT_REPORT_TURN_NAMES = ['core-only', 'calendar', 'web'] satisfies PromptReportTurn[];

const MODEL_NAME = 'personal/model';
/** Never sent anywhere: stands in for a credential field the report does not read. */
const STAND_IN = 'stand-in';
const WEB_SEARCH_SERVER = 'web-search';
const WEB_SEARCH_URL = 'https://mcp.tavily.com/mcp/';
const TENANT_ID = 'prompt-report';
const CREATED_BY = 'prompt-report-user';
const SESSION_ID = 'prompt-report-session';
const GOOGLE_READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const GOOGLE_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
];

/** What the connected Google login may do: the report measures reads; writes add the Gmail and Calendar write tools. */
export type GoogleAccess = 'read' | 'read_and_write';

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 600,
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
  pages: { maxCount: 6, maxTokens: 1500 },
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

function unusedUsageSessionReader(): UsageSessionReader {
  return {
    listSessions: () => unused('listSessions'),
    listSessionEvents: () => unused('listSessionEvents'),
  };
}

function unusedTokenFactoryBudget(): TokenFactoryBudget {
  return {
    isExhausted: () => unused('isExhausted'),
    assertWithinCap: () => unused('assertWithinCap'),
    record: () => unused('record'),
    today: () => unused('today'),
  };
}

function connectedGoogleStore(access: GoogleAccess): GoogleConnectionStore {
  const record: GoogleConnectionRecord = {
    tenant_id: TENANT_ID,
    created_by: CREATED_BY,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    client_id: 'prompt-report-client',
    client_secret: STAND_IN,
    client_type: 'web',
    refresh_token: STAND_IN,
    granted_scopes: access === 'read' ? GOOGLE_READ_SCOPES : [...GOOGLE_READ_SCOPES, ...GOOGLE_WRITE_SCOPES],
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

function personalSpec(input: { sandbox: boolean }): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: MODEL_NAME },
    instructions: '',
    config: { sandbox: { enabled: input.sandbox } },
    mcp_servers: [{ name: WEB_SEARCH_SERVER }],
  });
}

/** What a thread of one standard configuration is built from, as a turn builds it. */
export interface PersonalInstance {
  definition: ResolvedAgentDefinition['definition'];
  capabilities: AgentCapability[];
  /** Absent for a configuration whose spec turns the sandbox off. */
  sandbox: Sandbox | undefined;
  /** The permission context the turn's own thread gets, sharing the resolver's search state. */
  sentinel: SentinelHostContext;
}

/**
 * Builds one standard configuration. The resolver assembles the host capabilities exactly as a turn does;
 * the web search tools come from the search connector's own tool source, which the host also mounts per turn.
 */
export async function buildPersonalInstance(input: {
  name: PersonalInstanceName;
  googleAccess: GoogleAccess;
  sentinelServices: SentinelServices | undefined;
}): Promise<PersonalInstance> {
  const logger = createLogger({ silent: true });
  const tracing = NOOP_AGENT_TRACING;
  // The sandbox object exists only when the spec enables it, as in a real turn.
  const sandboxEnabled = input.name === 'personal' || input.name === 'personal-with-google';
  const spec = personalSpec({ sandbox: sandboxEnabled });
  const sandbox = new Sandbox({
    provider: sandboxProvider(),
    fileDownloadEnabled: spec.config.sandbox.file_downloads,
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
    summarize: undefined,
    providerServerName: undefined,
  };
  const space: SpaceTurnContext = {
    store: unusedSpaceStore(),
    authority: { tenantId: TENANT_ID, userRef: CREATED_BY },
    sessionId: SESSION_ID,
    logger,
    googleConnections: input.name === 'personal-with-google' ? connectedGoogleStore(input.googleAccess) : undefined,
    schedules: scheduleContext(logger),
    startsAnswer: true,
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
    {
      sessionStore: unusedUsageSessionReader(),
      budget: unusedTokenFactoryBudget(),
      authority: { tenantId: TENANT_ID, userRef: CREATED_BY },
    },
  );
  const resolved = await resolver.resolveAgentDefinition({
    spec,
    tenant_id: TENANT_ID,
    created_by: CREATED_BY,
    session_id: SESSION_ID,
    signal: new AbortController().signal,
    tracing,
    sentinel_services: input.sentinelServices,
  });
  const definition = resolved.definition;
  const capabilities = threadCapabilities({
    spec,
    definition,
    compactionModel: resolved.compactionModel,
    isChild: false,
    sandbox: sandboxEnabled ? sandbox : undefined,
    sandboxAvailable: sandboxEnabled,
    tracing,
    logger,
    extraCapabilities: resolved.extraCapabilities,
  });
  const sentinel = createSentinelHostContext({
    services: input.sentinelServices,
    tenant_id: TENANT_ID,
    created_by: CREATED_BY,
    conversation_id: SESSION_ID,
    web_search: resolver.webSearchTurn,
  });
  return { definition, capabilities, sandbox: sandboxEnabled ? sandbox : undefined, sentinel };
}

/** Measures one standard configuration answering one typical turn. */
export async function measurePersonalInstance(input: {
  name: PersonalInstanceName;
  turn: PromptReportTurn;
}): Promise<PromptReport> {
  const { definition, capabilities, sandbox } = await buildPersonalInstance({
    name: input.name,
    googleAccess: 'read',
    sentinelServices: undefined,
  });
  // 'personal-no-sandbox' turns the sandbox off for this chat while the server still has one (sandbox-off line).
  // 'personal-no-server-sandbox' has no server sandbox at all (no-sandbox line).
  return measurePromptRequest({
    definition,
    capabilities,
    sandbox,
    serverSandboxAvailable: input.name !== 'personal-no-server-sandbox',
    message: PROMPT_REPORT_TURNS[input.turn],
  });
}
