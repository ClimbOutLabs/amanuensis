// The bug-report bundle sources sandbox capability from the PERSISTED status only (read-only, no
// egress); the /capabilities route uses the refreshing check. Stub both so tests never touch
// Daytona, and so a test can assert the bug-report path never calls the refreshing (egress) check.
jest.mock('../../../src/sandbox/providerUtils', () => ({
  checkSnapshotStatus: jest.fn(),
  readPersistedSnapshotStatus: jest.fn(),
}));

import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { createClient } from 'redis';
import { createLogger } from 'winston';
import { createBugReportRouter } from '../../../src/apis/bugReport';
import { createSessionsRouter, TENANT_ID } from '../../../src/apis/sessions';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { setCachedLocalSandboxSupport } from '../../../src/sandbox/localRuntime';
import { checkSnapshotStatus, readPersistedSnapshotStatus } from '../../../src/sandbox/providerUtils';

const mockStatus = checkSnapshotStatus as jest.Mock;
const mockPersistedStatus = readPersistedSnapshotStatus as jest.Mock;

const inlineSpec = AgentSpecSchema.parse({
  model: { name: 'anthropic/claude-sonnet-4-6' },
  instructions: 'inline',
});

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('bug-report HTTP endpoint', () => {
  let app: OpenAPIHono;
  let sessionStore: SqliteSessionStore;
  let agentStore: SqliteAgentStore;

  beforeEach(async () => {
    mockStatus.mockReset();
    mockStatus.mockResolvedValue(undefined);
    mockPersistedStatus.mockReset();
    mockPersistedStatus.mockResolvedValue(undefined);
    setCachedLocalSandboxSupport(undefined);

    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    sessionStore = new SqliteSessionStore(db);
    const sessions = new Sessions({ sessionStore });
    const modelProviderStore = new SqliteModelProviderStore(db);
    const mcpServerStore = new SqliteMcpServerStore(db);
    const skillStore = new SqliteSkillStore(db);
    const sandboxProviderStore = new SqliteSandboxProviderStore(db);
    agentStore = new SqliteAgentStore(db);

    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      name: 'anthropic',
      manifest: {
        type: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        auth: { api_key: 'sk-ant-test' },
        models: [
          {
            model_id: 'claude-sonnet-4-6',
            name: 'claude-sonnet-4-6',
            properties: { context_length: 200000, max_output_tokens: 32768 },
          },
        ],
      },
    });

    app = new OpenAPIHono();
    app.route(
      '/',
      createSessionsRouter({
        sessions,
        sessionStore,
        sentinelAuditStore: new SentinelAuditStore(db),
        activeTurns: new ActiveTurnRegistry(),
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
      createBugReportRouter({
        sessions,
        agentStore,
        sandboxProviderStore,
        mcpServerStore,
        globalSettingsStore: new SqliteGlobalSettingsStore(db),
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
        logger: createLogger({ silent: true }),
      }),
    );
  });

  afterEach(() => {
    setCachedLocalSandboxSupport(undefined);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await app.request('/does-not-exist/bug-report', jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's session", async () => {
    await sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: 'other-user-session',
      created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone-else' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: inlineSpec },
      custom: null,
    });

    const res = await app.request('/other-user-session/bug-report', jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('carries the chat only when the request opts in', async () => {
    const created = await app.request('/', jsonInit('POST', { agent: { spec: inlineSpec } }));
    const { data: session } = (await created.json()) as { data: { id: string } };

    const plain = await app.request(`/${session.id}/bug-report`, jsonInit('POST', {}));
    expect(plain.status).toBe(200);
    expect((await plain.json()) as { data: Record<string, unknown> }).toEqual(
      expect.objectContaining({ data: expect.not.objectContaining({ chat: expect.anything() }) }),
    );

    const optedIn = await app.request(`/${session.id}/bug-report`, jsonInit('POST', { include_chat: true }));
    expect(optedIn.status).toBe(200);
    const { data } = (await optedIn.json()) as { data: { chat?: { messages: unknown[]; notes: string } } };
    expect(data.chat).toEqual({ messages: [], notes: expect.stringContaining("reporter's request") });
  });

  it('generates a bundle for an inline-agent session with no turns yet', async () => {
    const created = await app.request('/', jsonInit('POST', { agent: { spec: inlineSpec } }));
    expect(created.status).toBe(201);
    const { data: session } = (await created.json()) as { data: { id: string } };

    // Isolate the bug-report request so the assertion below covers only its work.
    mockStatus.mockClear();
    mockPersistedStatus.mockClear();

    const res = await app.request(
      `/${session.id}/bug-report`,
      jsonInit('POST', { description: 'Nothing happened when I hit send.' }),
    );
    expect(res.status).toBe(200);

    // Generating a bug report must stay local: it reads the persisted sandbox status
    // and must never invoke the refreshing check, which can dial the Daytona provider and mutate
    // sandbox state.
    expect(mockPersistedStatus).toHaveBeenCalledTimes(1);
    expect(mockStatus).not.toHaveBeenCalled();
    const { data: bundle } = (await res.json()) as {
      data: {
        schema_version: number;
        session: {
          id: string;
          agent_name: string | null;
          model: string | null;
          connectors: string[];
          skills: string[];
          sandbox_enabled: boolean;
        };
        user_description: string;
        summary: string[];
        trace: unknown[];
        recent_errors: unknown[];
        config_flags: { sandbox_enabled: boolean; skill_enabled: boolean; settings_enabled: boolean };
        redaction: { stripped_fields: string[]; notes: string };
      };
    };

    expect(bundle.schema_version).toBe(1);
    expect(bundle.session.id).toBe(session.id);
    expect(bundle.session.agent_name).toBeNull();
    expect(bundle.session.model).toBe('anthropic/claude-sonnet-4-6');
    expect(bundle.session).toMatchObject({ connectors: [], skills: [], sandbox_enabled: false });
    expect(bundle.summary).toEqual([]);
    expect(bundle.user_description).toBe('Nothing happened when I hit send.');
    expect(bundle.trace).toEqual([]);
    expect(bundle.recent_errors).toEqual([]);
    // hasAdminRole() is always true with OIDC disabled (the default in tests), so settings reads enabled.
    expect(bundle.config_flags).toEqual({ sandbox_enabled: false, skill_enabled: false, settings_enabled: true });
    expect(bundle.redaction.stripped_fields.length).toBeGreaterThan(0);
  });

  it('resolves the registry agent name and model for a named session', async () => {
    const agent = await agentStore.createAgent({
      tenant_id: TENANT_ID,
      created_by_subject: { subject_id: 'tester', subject_type: 'user', subject_display_name: 'tester' },
      name: 'named-agent',
      description: 'Named agent used in bug-report tests.',
      manifest: AgentSpecSchema.parse({
        model: { name: 'anthropic/claude-sonnet-4-6' },
        instructions: 'from-registry',
      }),
      external_id: null,
    });
    const created = await app.request('/', jsonInit('POST', { agent: { name: agent.name } }));
    expect(created.status).toBe(201);
    const { data: session } = (await created.json()) as { data: { id: string } };

    const res = await app.request(`/${session.id}/bug-report`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    const { data: bundle } = (await res.json()) as {
      data: { session: { agent_name: string | null; model: string | null } };
    };
    expect(bundle.session.agent_name).toBe('named-agent');
    expect(bundle.session.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('defaults user_description to empty string when the field is omitted', async () => {
    const created = await app.request('/', jsonInit('POST', { agent: { spec: inlineSpec } }));
    const { data: session } = (await created.json()) as { data: { id: string } };

    const res = await app.request(`/${session.id}/bug-report`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    const { data: bundle } = (await res.json()) as { data: { user_description: string } };
    expect(bundle.user_description).toBe('');
  });
});
