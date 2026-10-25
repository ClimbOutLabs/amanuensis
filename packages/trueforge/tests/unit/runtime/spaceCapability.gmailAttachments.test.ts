/**
 * Whether a chat is offered `download_attachment` follows its sandbox: the resolver hands the run's sandbox to the
 * Gmail tools, and without one the tool is hidden. These go through the real resolver and the real schedule path.
 */
import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  Sessions,
  type AgentSpec,
} from '@truefoundry/trueforge-core/agent-session';
import { createSentinelHostContext, Sandbox, type ILLM } from '@truefoundry/trueforge-core/core';
import { defaultSentinelServices } from '@truefoundry/trueforge-core/core/permissions/context';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeSandboxProvider } from '../../fixtures/fakeSandboxProvider';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const OWNER = { tenant_id: 't1', created_by: 'u1' };
const logger = createLogger({ silent: true });

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

function spec({ sandbox }: { sandbox: boolean }): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'scripted/chat-model' },
    instructions: 'Answer the user.',
    config: { sandbox: { enabled: sandbox } },
  });
}

function fakeSandbox(): Sandbox {
  return new Sandbox({
    provider: new FakeSandboxProvider(new Map()),
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 10_000,
    mcpConnectTimeoutMs: 5_000,
    logger,
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('download_attachment follows the chat sandbox', () => {
  let env: SqliteTestDatabase;
  let connections: SqliteGoogleConnectionStore;

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

  function resolver({ withSandbox }: { withSandbox: boolean }) {
    return new SpaceTurnResourceResolver(
      {
        llm: () =>
          Promise.resolve({
            modelClient: stubModel(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () => Promise.reject(new Error('no connectors in this test')),
        mcpRequestTimeoutMs: 10_000,
        mcpConnectTimeoutMs: 10_000,
        sandboxProvider: withSandbox ? () => Promise.resolve(fakeSandbox()) : undefined,
        logger,
      },
      undefined,
      undefined,
      memory,
      NO_SCREEN,
      undefined,
      undefined,
      undefined,
      {
        outboundSecrets: () => Promise.resolve([]),
        store: STORE,
        googleConnections: connections,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
        sessionId: 's1',
        logger,
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

  async function mailTools(resolved: Awaited<ReturnType<SpaceTurnResourceResolver['resolveAgentDefinition']>>) {
    const mail = (resolved.extraCapabilities ?? [])
      .flatMap(capability => capability.systemToolSets ?? [])
      .find(toolSet => toolSet.name === 'gmail');
    if (mail === undefined) {
      throw new Error('expected the Gmail tools to be mounted');
    }
    const listed = await mail.listTools();
    return 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
  }

  async function resolveDirectly({ withSandbox, sandboxOn }: { withSandbox: boolean; sandboxOn: boolean }) {
    const turnResolver = resolver({ withSandbox });
    const common = {
      spec: spec({ sandbox: sandboxOn }),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    };
    await turnResolver.resolveSandbox({
      ...common,
      turn_id: 'turn-1',
      sentinel: createSentinelHostContext({
        ...OWNER,
        conversation_id: 's1',
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
    });
    return await turnResolver.resolveAgentDefinition(common);
  }

  it('offers it when the chat has a sandbox', async () => {
    expect(await mailTools(await resolveDirectly({ withSandbox: true, sandboxOn: true }))).toContain(
      'download_attachment',
    );
  });

  it('hides it when the agent has the sandbox off', async () => {
    const names = await mailTools(await resolveDirectly({ withSandbox: true, sandboxOn: false }));
    expect(names).toContain('read_email');
    expect(names).not.toContain('download_attachment');
  });

  it('hides it when this installation has no sandbox to give', async () => {
    const names = await mailTools(await resolveDirectly({ withSandbox: false, sandboxOn: true }));
    expect(names).not.toContain('download_attachment');
  });

  describe('through the schedule path', () => {
    async function namesFor({ source }: { source: { type: 'schedule'; id: string; run_id: string } | null }) {
      const captured: Awaited<ReturnType<SpaceTurnResourceResolver['resolveAgentDefinition']>>[] = [];
      const inner = resolver({ withSandbox: true });
      const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
      const session = await sessions.create({
        tenant_id: OWNER.tenant_id,
        session_id: 's1',
        created_by_subject: { subject_id: OWNER.created_by, subject_type: 'user', subject_display_name: 'Ada' },
        agent: { type: 'inline', spec: spec({ sandbox: true }) },
        external_id: null,
        source,
      });
      // Both calls reach the one real resolver, as the session does, so it keeps the sandbox between them.
      const recording = Object.create(inner, {
        resolveSandbox: {
          value: (...args: Parameters<SpaceTurnResourceResolver['resolveSandbox']>) => inner.resolveSandbox(...args),
        },
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
      return await mailTools(root);
    }

    it('is offered the same way in a chat and in a scheduled run, which may read mail but never writes it', async () => {
      expect(await namesFor({ source: null })).toContain('download_attachment');
      expect(await namesFor({ source: { type: 'schedule', id: 'sched-1', run_id: 'run-1' } })).toContain(
        'download_attachment',
      );
    });
  });
});
