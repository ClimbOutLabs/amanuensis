/**
 * What an incognito chat is offered at the resolver: it can read Aman's spaces but not write them,
 * the web browser (which keeps a lasting profile) is off, and the model is told so. A normal chat
 * keeps every tool.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import { InstructionBuilder, type ILLM } from '@truefoundry/trueforge-core/core';
import { isAuthRequired } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { createLogger } from 'winston';
import configuration from '../../../src/config';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';
import { noSpaceFolders } from './spaceFolderStoreFake';

const OWNER = { tenant_id: 't1', created_by: 'u1' };

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};
const NO_SCREEN: ToolOutputScreenConfig = { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 };

const STORE: SpaceToolStore = {
  createSpace: jest.fn(),
  updateSpace: jest.fn(),
  revertSpace: jest.fn(),
  listSpacesWithAggregate: jest.fn(),
  getSpace: jest.fn(),
  getSpaceRevision: jest.fn(),
  ...noSpaceFolders,
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
  return AgentSpecSchema.parse({ model: { name: 'scripted/chat-model' }, instructions: 'Answer the user.' });
}

describe('the tools an incognito chat is offered', () => {
  let env: SqliteTestDatabase;
  const browserWasEnabled = configuration.BROWSER_ENABLED;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    configuration.BROWSER_ENABLED = true;
  }, 120_000);

  afterEach(async () => {
    configuration.BROWSER_ENABLED = browserWasEnabled;
    await env.teardown();
  });

  async function resolve(keepsNothing: boolean) {
    const memory: MemoryTurnContext = {
      keepsNothing,
      client: undefined,
      config: MEMORY_CONFIG,
      sessionId: 's1',
      previousTurnId: null,
      summarize: undefined,
    };
    const turnResolver = new SpaceTurnResourceResolver(
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
        deletedChats: { listDeletedChatModelUsage: () => Promise.resolve([]) },
        sessionStore: new SqliteSessionStore(env.db),
        budget: uncappedTokenFactoryBudget,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
      },
      undefined,
    );
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    });
    const capabilities = resolved.extraCapabilities ?? [];
    const toolSets = capabilities.flatMap(capability => capability.systemToolSets ?? []);
    const prompt = InstructionBuilder.createSystemPrompt('test');
    for (const capability of capabilities) {
      for (const build of capability.instructionBuilders ?? []) {
        build(prompt);
      }
    }
    const toolNames = async (setName: string): Promise<string[]> => {
      const toolSet = toolSets.find(candidate => candidate.name === setName);
      const listed = toolSet === undefined ? undefined : await toolSet.listTools();
      return listed === undefined || isAuthRequired(listed) ? [] : listed.result.tools.map(tool => tool.name);
    };
    return { toolSetNames: toolSets.map(toolSet => toolSet.name), toolNames, prompt: prompt.build() };
  }

  it('reads spaces but cannot write them, has no browser, and is told so', async () => {
    const chat = await resolve(true);
    expect((await chat.toolNames('space')).sort()).toEqual(['get_space', 'list_blocks', 'list_spaces']);
    expect(chat.toolSetNames.some(name => name.includes('browser'))).toBe(false);
    expect(chat.prompt).toContain('This is an incognito chat.');
    expect(chat.prompt).toContain('the web browser is off');
  });

  it('keeps every tool in a normal chat', async () => {
    const chat = await resolve(false);
    expect(await chat.toolNames('space')).toEqual(
      expect.arrayContaining(['create_space', 'edit_space', 'revert_space', 'move_space']),
    );
    expect(chat.toolSetNames.some(name => name.includes('browser'))).toBe(true);
    expect(chat.prompt).not.toContain('This is an incognito chat.');
  });
});
