/**
 * The connection offer, mounted by the real turn resolver: a person with no email connected and no
 * remembered no gets the offer tools in the chat. A saved mail account or a remembered decline
 * leaves the turn without them, so the offer cannot chase the person from a later chat. An
 * unattended run (a schedule) never gets them: nobody can answer the card there, and a decline
 * recorded by the run would hold in every chat.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { connectionOfferDeclinedSettingKey } from '../../../src/runtime/connectionOfferRegistry';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';
import { noSpaceFolders } from './spaceFolderStoreFake';

const OWNER = { tenant_id: 't1', created_by: 'u1' };
const EMAIL_DECLINED_KEY = connectionOfferDeclinedSettingKey('email');

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
  keepsNothing: false,
};

const STORE: SpaceToolStore = {
  createSpace: jest.fn(),
  updateSpace: jest.fn(),
  revertSpace: jest.fn(),
  listSpacesWithAggregate: jest.fn(),
  getSpace: jest.fn(),
  ...noSpaceFolders,
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
  });
}

describe('the connection offer mount', () => {
  let env: SqliteTestDatabase;
  let settings: SqliteGlobalSettingsStore;
  let mailConnectorRegistered: boolean;
  let unattendedRun: boolean;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    settings = new SqliteGlobalSettingsStore(env.db);
    mailConnectorRegistered = false;
    unattendedRun = false;
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
        unattended: unattendedRun,
        connectionOffer: {
          settings,
          mailConnectorRegistered: () => Promise.resolve(mailConnectorRegistered),
        },
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
        deletedChats: { listDeletedChatModelUsage: () => Promise.resolve([]) },
        budget: uncappedTokenFactoryBudget,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
      },
      undefined,
    );
  }

  async function offerCapability() {
    const turnResolver = resolver();
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    });
    for (const capability of resolved.extraCapabilities ?? []) {
      for (const set of capability.systemToolSets ?? []) {
        if (set.name === 'connection_offer') {
          const listed = await set.listTools();
          const tools = 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
          return { tools, instructionBuilders: (capability.instructionBuilders ?? []).length };
        }
      }
    }
    return undefined;
  }

  it('mounts the offer tools and guidance when no email is connected', async () => {
    const mounted = await offerCapability();
    expect(mounted?.tools).toEqual(['connection_offer_status', 'record_connection_offer_decline']);
    expect(mounted?.instructionBuilders).toBe(1);
  });

  it('mounts nothing once a mail account is saved', async () => {
    mailConnectorRegistered = true;
    expect(await offerCapability()).toBeUndefined();
  });

  it('mounts nothing after the person has turned the offer down', async () => {
    await settings.setSetting({ key: EMAIL_DECLINED_KEY, value: 'true' });
    expect(await offerCapability()).toBeUndefined();
  });

  it('mounts nothing on an unattended run, so no card waits unanswered and no decline can be recorded', async () => {
    unattendedRun = true;
    expect(await offerCapability()).toBeUndefined();
    expect(await settings.getSetting({ key: EMAIL_DECLINED_KEY })).toBeUndefined();
  });
});
