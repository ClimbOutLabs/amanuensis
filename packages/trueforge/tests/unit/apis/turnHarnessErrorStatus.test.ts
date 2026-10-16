import { OpenAPIHono } from '@hono/zod-openapi';
import { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { AgentHarnessError } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { createTurnsRouter } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';

async function postTurnRejectingWith(error: AgentHarnessError): Promise<Response> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  await modelProviderStore.upsertProvider({
    tenant_id: 'default',
    name: 'test-provider',
    manifest: {
      type: 'custom',
      name: 'test-provider',
      base_url: 'https://llm.test.example.com/v1',
      auth: { api_key: 'sk-test' },
      models: [
        {
          model_id: 'test-model',
          name: 'test-model',
          properties: { context_length: 128000, max_output_tokens: 4096 },
        },
      ],
    },
  });

  const sessions = {
    get: () =>
      Promise.resolve({
        session_id: 's1',
        tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
        agent_spec: { model: { name: 'test-provider/test-model' } },
        record: {
          last_turn_id: null,
          created_by_subject: {
            subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
            subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
            subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
          },
          agent: { type: 'inline', spec: { model: { name: 'test-provider/test-model' } } },
          repository_id: null,
          workspace_cwd: null,
        },
        answersOnlyHeldActions: () => Promise.resolve(false),
        createTurn: () => Promise.reject(error),
        classifyApprovalResubmission: () => Promise.resolve({ outcome: 'unrecorded' }),
      }),
  } as unknown as Sessions<SessionCustom, TurnCustom>;

  const app = new OpenAPIHono();
  app.onError((_error, c) => c.json({ error: { message: 'Internal server error' } }, 500));
  app.route(
    '/',
    createTurnsRouter({
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      sessions,
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
      turnDrains: new TurnDrainRegistry(),
      tokenStore,
      resolveModelProviderStore: () => modelProviderStore,
      resolveMcpServerStore: () =>
        new McpServerWithAuthStore({
          store: new SqliteMcpServerStore(db),
          tokenStore,
          clientName: 'test-client',
        }),
      resolveSkillStore: () => new SqliteSkillStore(db),
      resolveAgentStore: () => new SqliteAgentStore(db),
      personalizationStore: new SqlitePersonalizationStore(db),
      personaStore: new SqlitePersonaStore(db),
      spaceStore: new SqliteSpaceStore(db),
      repositoryStore: new SqliteRepositoryStore(db),
      turnArtifactStore: new SqliteTurnArtifactStore(db),
      eventSubscriptions: new EventSubscriptionRegistry(undefined),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      logger: createLogger({ silent: true }),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );

  return app.request('/s1/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('harness rejections on POST /{session_id}/turns', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['agent_sandbox_required', 422],
    ['invalid_send_input', 422],
    ['tool_name_collision', 422],
    ['invalid_file_input', 400],
  ] as const)('maps %s to %i', async (code, status) => {
    const response = await postTurnRejectingWith(new AgentHarnessError(code, 'rejected'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { message: 'rejected' } });
  });

  it('keeps capability state failures as internal errors', async () => {
    const response = await postTurnRejectingWith(new AgentHarnessError('capability_state_error', 'rejected'));
    expect(response.status).toBe(500);
  });
});
