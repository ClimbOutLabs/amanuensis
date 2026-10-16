import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { createClient } from 'redis';
import { createLogger } from 'winston';
import { createSessionsRouter } from '../../../src/apis/sessions';
import { createTurnsRouter } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
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
import { ListSessionsResponseSchema } from '../../../src/schemas/session';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

describe('public CRUD after session deletion', () => {
  it('returns not found for session and turn operations', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const sessionStore = new SqliteSessionStore(db);
    const sessions = new Sessions({ sessionStore });
    const activeTurns = new ActiveTurnRegistry();
    const modelProviderStore = new SqliteModelProviderStore(db);
    const tokenStore = new SqliteOAuthTokenStore(db);
    const mcpServerStore = new McpServerWithAuthStore({
      store: new SqliteMcpServerStore(db),
      tokenStore,
      clientName: 'test-client',
    });
    const skillStore = new SqliteSkillStore(db);
    const agentStore = new SqliteAgentStore(db);
    const personalizationStore = new SqlitePersonalizationStore(db);
    const personaStore = new SqlitePersonaStore(db);
    const spaceStore = new SqliteSpaceStore(db);
    const repositoryStore = new SqliteRepositoryStore(db);
    const turnArtifactStore = new SqliteTurnArtifactStore(db);
    const sandboxProviderStore = new SqliteSandboxProviderStore(db);
    const app = new OpenAPIHono();

    app.route(
      '/',
      createSessionsRouter({
        sessions,
        sessionStore,
        sentinelAuditStore: new SentinelAuditStore(db),
        activeTurns,
        resolveModelProviderStore: () => modelProviderStore,
        resolveMcpServerStore: () => mcpServerStore,
        resolveSkillStore: () => skillStore,
        resolveAgentStore: () => agentStore,
        resolveSandboxProviderStore: () => sandboxProviderStore,
        redis: createClient(),
        requestReplyRouter: new RequestReplyRouter(),
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
        logger: createLogger({ silent: true }),
        authorizer: new TrueForgeAuthorizer(),
      }),
    );
    app.route(
      '/',
      createTurnsRouter({
        globalSettingsStore: new SqliteGlobalSettingsStore(db),
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        sessions,
        sessionStore,
        activeTurns,
        turnDrains: new TurnDrainRegistry(),
        resolveModelProviderStore: () => modelProviderStore,
        resolveMcpServerStore: () => mcpServerStore,
        resolveSkillStore: () => skillStore,
        resolveAgentStore: () => agentStore,
        tokenStore,
        personalizationStore,
        personaStore,
        spaceStore,
        repositoryStore,
        turnArtifactStore,
        eventSubscriptions: new EventSubscriptionRegistry(undefined),
        resolveSandboxProviderStore: () => sandboxProviderStore,
        logger: createLogger({ silent: true }),
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
        authorizer: new TrueForgeAuthorizer(),
      }),
    );

    await sessionStore.createSession({
      tenant_id: 'default',
      session_id: 's1',
      created_by_subject: {
        subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
        subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
        subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
      },
      agent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
        }),
      },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    expect((await app.request('/s1', { method: 'DELETE' })).status).toBe(204);

    const requests = [
      app.request('/s1'),
      app.request('/s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      app.request('/s1/events'),
      app.request('/s1/cancel', { method: 'POST' }),
      app.request('/s1/turns'),
      app.request('/s1/turns/turn-1'),
      app.request('/s1/turns/turn-1/events'),
      app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
    }

    const listed = await app.request('/');
    expect(listed.status).toBe(200);
    expect(ListSessionsResponseSchema.parse(await listed.json()).data).toEqual([]);
    expect((await app.request('/s1', { method: 'DELETE' })).status).toBe(204);
  });
});
