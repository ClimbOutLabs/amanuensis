/**
 * A chat that read the person's mail keeps searching without asking: the person's own mail is theirs to use. These
 * assertions go through the real resolver and the real schedule path: the Gmail tool and the search tool come from
 * the same turn's resolved definition, so they share the turn state exactly as production does.
 */
import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  Sessions,
  type AgentSpec,
} from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import {
  createSentinelHostContext,
  defaultSentinelServices,
} from '@truefoundry/trueforge-core/core/permissions/context';
import type { WebSearchTurnState } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import { classifyUnstampedToolCall } from '@truefoundry/trueforge-core/core/runtime/AgentThread';
import { createLogger } from 'winston';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { INERT_WEB_SEARCH_TOOL, startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';
import { installRecordedMail, MAIL_SENDER_NAME } from '../../fixtures/recordedMail';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const OWNER = { tenant_id: 't1', created_by: 'u1' };

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
const NO_SCREEN: ToolOutputScreenConfig = { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 };
const memory: MemoryTurnContext = {
  client: undefined,
  config: MEMORY_CONFIG,
  sessionId: 's1',
  previousTurnId: null,
  summarize: undefined,
  providerServerName: undefined,
};

const STORE: SpaceToolStore = {
  createSpace: jest.fn(),
  updateSpace: jest.fn(),
  revertSpace: jest.fn(),
  listSpacesWithAggregate: jest.fn(),
  getSpace: jest.fn(),
  getSpaceRevision: jest.fn(),
};

function stubModel(): ILLM {
  return {
    create: () =>
      (async function* () {
        await Promise.resolve();
        yield {
          id: 'chunk-1',
          object: 'chat.completion.chunk' as const,
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' as const, content: 'ok' }, finish_reason: 'stop' as const }],
        };
        return {
          output: { role: 'assistant' as const, content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: 'stop' as const,
        };
      })(),
    createNonStream: () => Promise.reject(new Error('unused')),
  };
}

function spec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'scripted/chat-model' },
    instructions: 'Answer the user.',
    mcp_servers: [{ name: 'finder' }],
  });
}

describe('a web search after the chat read mail', () => {
  let inert: InertMcpServer;
  let env: SqliteTestDatabase;
  let connections: SqliteGoogleConnectionStore;

  let mailFetch: ReturnType<typeof installRecordedMail>;

  beforeAll(async () => {
    inert = await startInertMcpServer({ webSearch: true });
  });
  afterAll(async () => {
    await inert.close();
  });
  beforeEach(() => {
    mailFetch = installRecordedMail();
  });
  afterEach(() => {
    mailFetch.restore();
  });
  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    connections = new SqliteGoogleConnectionStore(env.db);
    await connections.save({
      ...OWNER,
      client_id: '123456789-abcdefghij.apps.googleusercontent.com',
      client_secret: 'secret',
      client_type: 'desktop',
      refresh_token: 'rt',
      granted_scopes: [READ],
      account_email: 'ada@example.com',
      status: 'connected',
      created_at: '2026-10-15T00:00:00.000Z',
      updated_at: '2026-10-15T00:00:00.000Z',
    });
  }, 120_000);
  afterEach(async () => {
    await env.teardown();
  });

  function resolver() {
    return new SpaceTurnResourceResolver(
      {
        llm: () =>
          Promise.resolve({
            modelClient: stubModel(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () =>
          Promise.resolve({ url: inert.url, headers: {}, search_provider: { tools: [], plumbing_fields: [] } }),
        mcpRequestTimeoutMs: 10_000,
        mcpConnectTimeoutMs: 10_000,
        logger: createLogger({ silent: true }),
      },
      undefined,
      undefined,
      memory,
      NO_SCREEN,
      undefined,
      undefined,
      undefined,
      {
        store: STORE,
        googleConnections: connections,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
        sessionId: 's1',
        logger: createLogger({ silent: true }),
        startsAnswer: true,
      },
      {
        store: new FakeTurnArtifactStore(),
        tenantId: OWNER.tenant_id,
        sessionId: 's1',
        turnId: 't1',
        logger: createLogger({ silent: true }),
      },
      {
        sessionStore: new SqliteSessionStore(env.db),
        budget: uncappedTokenFactoryBudget,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
      },
    );
  }

  async function toolSetsOf(resolved: Awaited<ReturnType<SpaceTurnResourceResolver['resolveAgentDefinition']>>) {
    const gmail = (resolved.extraCapabilities ?? []).flatMap(capability => capability.systemToolSets ?? []);
    const finder = resolved.definition.toolSets?.find(toolSet => toolSet.name === 'finder');
    const mail = gmail.find(toolSet => toolSet.name === 'gmail');
    if (finder === undefined || mail === undefined) {
      throw new Error('expected the search connector and the Gmail tools to be mounted');
    }
    return { finder, mail };
  }

  /** Runs a mail read through the dispatch loop, the path every production read takes, so its result is recorded. */
  async function readMail(input: { mail: IToolSet; turn: WebSearchTurnState }) {
    const name = 'list_inbox_threads';
    await executeToolCalls({
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name, arguments: '{}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'gmail',
              mcp_server_name: 'gmail',
              is_approval_required: false,
              tier: 1,
              original_tool_name: name,
              read_only_hint: true,
            },
          },
        ],
      },
      toolMapping: new Map([[name, { toolSet: input.mail, originalToolName: name }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
      sentinel: {
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
        identity: {
          tenant_id: OWNER.tenant_id,
          created_by: OWNER.created_by,
          conversation_id: 's1',
          repository_id: null,
          workspace_cwd: null,
          agent_intent: null,
        },
        web_search: input.turn,
      },
    });
  }

  const search = (finder: IToolSet, query = 'lisbon tapas') =>
    finder.toolCallInfo({ name: INERT_WEB_SEARCH_TOOL, arguments: { query } });
  /** A search that names the sender of the mail the chat just read, as a person asking about them would. */
  const namedSender = `${MAIL_SENDER_NAME} tapas`;

  it('searches silently before and after a read, even a query that names the sender', async () => {
    const turnResolver = resolver();
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    const { finder, mail } = await toolSetsOf(resolved);
    expect((await search(finder)).tier).toBe(1);
    await readMail({ mail, turn: turnResolver.webSearchTurn });
    expect(await search(finder)).toMatchObject({ tier: 1, tier_reason: 'mcp_search_provider' });
    expect(await search(finder, namedSender)).toMatchObject({ tier: 1, is_approval_required: false });
  });

  it('makes a space the person asked for with no card, through the real built-in tool route', async () => {
    const turnResolver = resolver();
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    const space = (resolved.extraCapabilities ?? [])
      .flatMap(capability => capability.systemToolSets ?? [])
      .find(toolSet => toolSet.name === 'space');
    if (space === undefined) {
      throw new Error('expected the Spaces tools to be mounted');
    }
    const args = { name: 'Dog breeds', format: 'markdown', body: '# Dog breeds' };
    const classified = await classifyUnstampedToolCall({
      sentinel: createSentinelHostContext({
        tenant_id: OWNER.tenant_id,
        created_by: OWNER.created_by,
        conversation_id: 's1',
        web_search: turnResolver.webSearchTurn,
      }),
      canonical_params: args,
      info: await space.toolCallInfo({ name: 'create_space', arguments: args }),
    });

    expect(classified).toMatchObject({ tier: 1, tier_reason: 'space_write' });
    expect(classified.is_approval_required).not.toBe(true);
    expect(classified.tier3_card ?? null).toBeNull();
  });

  describe('through the schedule path', () => {
    async function resolvedForSource(source: { type: 'schedule'; id: string; run_id: string } | null) {
      const captured: Awaited<ReturnType<SpaceTurnResourceResolver['resolveAgentDefinition']>>[] = [];
      const inner = resolver();
      const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
      const session = await sessions.create({
        tenant_id: OWNER.tenant_id,
        session_id: 's1',
        created_by_subject: { subject_id: OWNER.created_by, subject_type: 'user', subject_display_name: 'Ada' },
        agent: { type: 'inline', spec: spec() },
        external_id: null,
        source,
      });
      const recording = Object.create(inner, {
        resolveAgentDefinition: {
          value: async (...args: Parameters<SpaceTurnResourceResolver['resolveAgentDefinition']>) => {
            const resolved = await inner.resolveAgentDefinition(...args);
            captured.push(resolved);
            return resolved;
          },
        },
      });
      const turn = await session.createTurn({
        turn_id: 'turn-1',
        input: [{ type: EventType.USER_MESSAGE, content: 'check my mail' }],
        previous_turn_id: 'none',
        signal: new AbortController().signal,
        resolver: recording,
      });
      for await (const event of turn.stream()) {
        void event;
      }
      const root = captured[0];
      if (root === undefined) {
        throw new Error('the turn never resolved a definition');
      }
      return { ...(await toolSetsOf(root)), turn: inner.webSearchTurn };
    }

    it('runs the search in an attended chat and in a scheduled run alike', async () => {
      const attended = await resolvedForSource(null);
      await readMail({ mail: attended.mail, turn: attended.turn });
      expect((await search(attended.finder, namedSender)).is_approval_required).toBe(false);

      const scheduled = await resolvedForSource({ type: 'schedule', id: 'sched-1', run_id: 'run-1' });
      await readMail({ mail: scheduled.mail, turn: scheduled.turn });
      const ran = await search(scheduled.finder, namedSender);
      expect(ran.is_approval_required).toBe(false);
      expect(ran.pre_dispatch_failure).toBeUndefined();
      expect(ran.tier).toBe(1);
    });
  });
});
