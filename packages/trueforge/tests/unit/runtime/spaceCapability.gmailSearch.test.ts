/**
 * Once a chat has read the user's mail, a web search stops running silently. These assertions go through the
 * real resolver and the real schedule path: the Gmail tool and the search tool come from the same turn's
 * resolved definition, so they share the turn state exactly as production does.
 */
import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  Sessions,
  type AgentSpec,
} from '@truefoundry/trueforge-core/agent-session';
import type { ILLM, IToolSet } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { INERT_WEB_SEARCH_TOOL, startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';

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
  sessionTitle: undefined,
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

  beforeAll(async () => {
    inert = await startInertMcpServer({ webSearch: true });
  });
  afterAll(async () => {
    await inert.close();
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
      },
      {
        store: new FakeTurnArtifactStore(),
        tenantId: OWNER.tenant_id,
        sessionId: 's1',
        turnId: 't1',
        logger: createLogger({ silent: true }),
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

  const search = (finder: IToolSet) =>
    finder.toolCallInfo({ name: INERT_WEB_SEARCH_TOOL, arguments: { query: 'lisbon tapas' } });

  it('searches silently until mail is read, then asks', async () => {
    const resolved = await resolver().resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    const { finder, mail } = await toolSetsOf(resolved);
    expect((await search(finder)).tier).toBe(1);
    await mail.toolCallInfo({ name: 'read_email', arguments: { message_id: 'm1' } });
    const after = await search(finder);
    expect(after.tier).toBe(3);
    expect(after.is_approval_required).toBe(true);
  });

  it('keeps asking in a later turn of the same chat, by carrying the flag in the root thread state', async () => {
    const first = await resolver().resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    const { mail } = await toolSetsOf(first);
    const capability = (first.extraCapabilities ?? []).find(candidate => candidate.state !== undefined);
    expect(capability?.state?.key).toBe('tfy.private_data_read');
    await mail.toolCallInfo({ name: 'read_email', arguments: { message_id: 'm1' } });
    const saved: unknown[] = [];
    for (const processor of capability?.postToolCallProcessors ?? []) {
      for await (const output of processor.processPostToolCall({
        threadId: 'root',
        currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
        context: [],
      })) {
        saved.push(output);
      }
    }
    expect(saved).toEqual([{ type: 'internal.capability.state', key: 'tfy.private_data_read', state: true }]);

    // The next turn builds a new resolver; the thread hands the saved value back to its capability.
    const second = await resolver().resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    const { finder } = await toolSetsOf(second);
    expect((await search(finder)).tier).toBe(1);
    second.extraCapabilities?.find(candidate => candidate.state !== undefined)?.state?.load(true);
    expect((await search(finder)).tier).toBe(3);
  });

  it('gives a sub-agent no capability of its own, only the shared turn state', async () => {
    const sub = await resolver().resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      agent_info: { type: 'dynamic', name: 'reviewer', input: 'check it' },
      signal: new AbortController().signal,
      tracing: resolver().createTracing(),
    });
    expect((sub.extraCapabilities ?? []).some(candidate => candidate.state !== undefined)).toBe(false);
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
      return await toolSetsOf(root);
    }

    it('asks an attended chat, and holds the search for the owner in a scheduled run', async () => {
      const attended = await resolvedForSource(null);
      await attended.mail.toolCallInfo({ name: 'read_email', arguments: { message_id: 'm1' } });
      expect((await search(attended.finder)).is_approval_required).toBe(true);

      const scheduled = await resolvedForSource({ type: 'schedule', id: 'sched-1', run_id: 'run-1' });
      await scheduled.mail.toolCallInfo({ name: 'read_email', arguments: { message_id: 'm1' } });
      const held = await search(scheduled.finder);
      expect(held.is_approval_required).toBe(true);
      expect(held.pre_dispatch_failure).toBeUndefined();
      expect(held.tier).toBe(3);
    });
  });
});
