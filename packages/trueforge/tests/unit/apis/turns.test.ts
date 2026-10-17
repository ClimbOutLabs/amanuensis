import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  SessionHandle,
  Sessions,
  TurnHandle,
  TurnNotFoundError,
  type TurnInputItem,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType, type AgentInputUserMessage } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import { TENANT_ID } from '../../../src/apis/sessions';
import { createTurnsRouter, deriveSessionTitle, extractUserMessageText, turnStreamId } from '../../../src/apis/turns';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
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
import type { Database } from '../../../src/db/sqlite/types';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

/** Standalone caller identity, spelled out as a plain string where a store expects one. */
const TEST_CREATED_BY = STANDALONE_REQUEST_CONTEXT.subject.id;
/** Standalone caller identity, as the `created_by_subject` object the session/agent stores expect. */
const TEST_CREATED_BY_SUBJECT = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

/**
 * A Sessions double assembled from real instances: the session record is read back from the
 * store, the handle and the turn are the harness's own classes, and only `get`, `createTurn` and
 * `stream` are scripted. Nothing is asserted into place, so a change to any of those contracts
 * fails this file at compile time rather than leaving a test that still passes over a shape the
 * server no longer produces.
 */
async function scriptedSessions(params: {
  sessionStore: SqliteSessionStore;
  sessionId: string;
  turnId: string;
  stream: () => AsyncGenerator<TurnStreamingEvent>;
}): Promise<Sessions<SessionCustom, TurnCustom>> {
  const record = await params.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: params.sessionId });
  if (record === undefined) {
    throw new Error(`test session ${params.sessionId} was never created`);
  }
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const turn = TurnHandle.fromRecord<TurnCustom>({
    store: params.sessionStore,
    turn: {
      turn_id: params.turnId,
      session_id: params.sessionId,
      first_turn_id: params.turnId,
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'running' },
      input: [],
      snapshot: { threads: {}, mcp_servers: null, sandbox_info: null },
      created_at: createdAt,
      updated_at: createdAt,
      custom: null,
    },
  });
  jest.spyOn(turn, 'stream').mockImplementation(params.stream);
  const handle = new SessionHandle<SessionCustom, TurnCustom>({ store: params.sessionStore, session: record });
  jest.spyOn(handle, 'createTurn').mockResolvedValue(turn);
  const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore: params.sessionStore });
  jest.spyOn(sessions, 'get').mockResolvedValue(handle);
  return sessions;
}

function mcpServerStoreWithAuth(db: Kysely<Database>, tokenStore: SqliteOAuthTokenStore) {
  return new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore,
    clientName: 'test-client',
  });
}

describe('turns', () => {
  it('namespaces turn stream ids under tfg', () => {
    expect(turnStreamId('ten', 'sess', 'turn1')).toBe('tfg:agent:turn:ten:sess:turn1:stream');
  });

  describe('deriveSessionTitle', () => {
    function userMessage(content: string): TurnInputItem[] {
      return [{ type: 'user.message', content }];
    }

    it('caps long titles at 50 characters', () => {
      expect(deriveSessionTitle(userMessage('x'.repeat(200)))).toBe('x'.repeat(50));
    });

    it('returns short titles unchanged', () => {
      expect(deriveSessionTitle(userMessage('hello world'))).toBe('hello world');
    });

    it('returns undefined when no usable text is present', () => {
      expect(deriveSessionTitle(undefined)).toBeUndefined();
      expect(deriveSessionTitle([])).toBeUndefined();
      expect(deriveSessionTitle(userMessage('   '))).toBeUndefined();
    });

    it('keeps an emoji pair fully inside the cap', () => {
      const text = `${'b'.repeat(48)}😀`;
      expect(deriveSessionTitle(userMessage(text))).toBe(text);
    });

    it('backs off when the cap would split a surrogate pair', () => {
      const title = deriveSessionTitle(userMessage(`${'a'.repeat(49)}😀 and more`));
      expect(title).toBe('a'.repeat(49));
    });

    it('drops a skin-tone cluster that would cross the cap instead of keeping its base', () => {
      const title = deriveSessionTitle(userMessage(`${'x'.repeat(48)}👋🏽 and more`));
      expect(title).toBe('x'.repeat(48));
    });

    it('keeps a skin-tone cluster that fits exactly inside the cap', () => {
      const text = `${'y'.repeat(46)}👋🏽`;
      expect(deriveSessionTitle(userMessage(text))).toBe(text);
    });

    it('drops a ZWJ sequence that would cross the cap', () => {
      const title = deriveSessionTitle(userMessage(`${'z'.repeat(44)}👨‍👩‍👧‍👦 and more`));
      expect(title).toBe('z'.repeat(44));
    });

    it('returns undefined when a single cluster exceeds the cap', () => {
      expect(deriveSessionTitle(userMessage(`e${'\u0301'.repeat(60)}`))).toBeUndefined();
    });
  });

  describe('turn ownership', () => {
    it('returns 403 for all turn routes when the caller is not the session creator', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });

      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone-else' },
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

      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore,
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
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

      const forbiddenAccess = { error: { message: 'Only the session creator can access this session' } };

      const createResponse = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(createResponse.status).toBe(403);
      expect(await createResponse.json()).toEqual({
        error: { message: 'Only the session creator can create turns' },
      });

      const listResponse = await app.request('/s1/turns');
      expect(listResponse.status).toBe(403);
      expect(await listResponse.json()).toEqual(forbiddenAccess);

      const getResponse = await app.request('/s1/turns/any-turn');
      expect(getResponse.status).toBe(403);
      expect(await getResponse.json()).toEqual(forbiddenAccess);

      const eventsResponse = await app.request('/s1/turns/any-turn/events');
      expect(eventsResponse.status).toBe(403);
      expect(await eventsResponse.json()).toEqual(forbiddenAccess);

      const subscribeResponse = await app.request('/s1/turns/any-turn/subscribe');
      expect(subscribeResponse.status).toBe(403);
      expect(await subscribeResponse.json()).toEqual(forbiddenAccess);

      const downloadResponse = await app.request(
        `/s1/turns/any-turn/download-sandbox-file?path=${encodeURIComponent('/workspace/report.pdf')}`,
      );
      expect(downloadResponse.status).toBe(403);
      expect(await downloadResponse.json()).toEqual(forbiddenAccess);
    });

    it('lets an agent manager use read routes but keeps create-turn and sandbox download creator-only', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const agentStore = new SqliteAgentStore(db);
      const agent = await agentStore.createAgent({
        tenant_id: 'default',
        name: 'managed-agent',
        description: 'Test agent.',
        manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
        external_id: 'managed-agent-external',
        created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'Owner' },
      });
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 'managed-session',
        created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'Owner' },
        agent: { type: 'reference', id: agent.id, name: agent.name },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions: new Sessions({ sessionStore }),
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore: new SqliteOAuthTokenStore(db),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => agentStore,
          personalizationStore: new SqlitePersonalizationStore(db),
          personaStore: new SqlitePersonaStore(db),
          spaceStore: new SqliteSpaceStore(db),
          repositoryStore: new SqliteRepositoryStore(db),
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: {
            listAgentAccess: input =>
              Promise.resolve(
                input.action === 'manage'
                  ? { kind: 'agent_external_ids', agent_external_ids: ['managed-agent-external'] }
                  : { kind: 'agent_external_ids', agent_external_ids: [] },
              ),
            canAccessAgent: () => Promise.resolve(false),
            getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
          },
        }),
      );

      expect((await app.request('/managed-session/turns')).status).toBe(200);
      expect((await app.request('/managed-session/turns/missing')).status).toBe(404);
      expect((await app.request('/managed-session/turns/missing/events')).status).toBe(404);
      expect((await app.request('/managed-session/turns/missing/subscribe')).status).toBe(404);
      expect(
        (
          await app.request(
            `/managed-session/turns/missing/download-sandbox-file?path=${encodeURIComponent('/workspace/file.txt')}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request('/managed-session/turns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stream: false }),
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('extractUserMessageText', () => {
    function userMessage(content: AgentInputUserMessage['content']): TurnInputItem {
      return { type: EventType.USER_MESSAGE, content };
    }

    const toolResponseItem: TurnInputItem = {
      type: EventType.USER_TOOL_RESPONSE,
      thread_id: 't1',
      tool_call_id: 'c1',
      content: 'ignored',
    };

    it('returns an empty string for undefined or empty input', () => {
      expect(extractUserMessageText(undefined)).toBe('');
      expect(extractUserMessageText([])).toBe('');
    });

    it('returns a single user message text unchanged', () => {
      const input = [userMessage('hello there')];
      expect(extractUserMessageText(input)).toBe('hello there');
    });

    it('concatenates every user message in order, joined by a blank line', () => {
      const input = [userMessage('first message'), toolResponseItem, userMessage('second message')];
      expect(extractUserMessageText(input)).toBe('first message\n\nsecond message');
    });

    it('excludes file parts from structured content while keeping text parts, across multiple messages', () => {
      const input = [
        userMessage([
          { type: 'text', text: 'see attached' },
          { type: 'file', name: 'report.pdf', data: 'data:application/pdf;base64,AAAA' },
        ]),
        userMessage([{ type: 'text', text: 'and this too' }]),
      ];
      expect(extractUserMessageText(input)).toBe('see attached\n\nand this too');
    });

    it('ignores non-user-message input items entirely', () => {
      expect(extractUserMessageText([toolResponseItem])).toBe('');
    });

    it('excludes a name carried in a tool result, feeding the profile learner only the user turn', () => {
      const toolResponseWithName: TurnInputItem = {
        type: EventType.USER_TOOL_RESPONSE,
        thread_id: 't1',
        tool_call_id: 'c1',
        content: 'Prepared for: Aman (QA tester).',
      };
      const input = [userMessage('what is my name?'), toolResponseWithName];
      expect(extractUserMessageText(input)).toBe('what is my name?');
    });
  });

  describe('create turn non-streaming', () => {
    it('returns the running turn JSON after dual-writing turn.created so subscribe can attach', async () => {
      const logger = createLogger({ silent: true });
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const modelProviderStore = new SqliteModelProviderStore(db);
      const sessionStore = new SqliteSessionStore(db);
      const repositoryStore = new SqliteRepositoryStore(db);
      const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
      const repository = await repositoryStore.createRepository({
        tenant_id: TENANT_ID,
        created_by: TEST_CREATED_BY,
        name: 'bound-demo',
        clone_url: 'https://example.test/bound-demo.git',
        default_branch: 'main',
      });
      await repositoryStore.upsertVerifyCommand({
        tenant_id: TENANT_ID,
        created_by: TEST_CREATED_BY,
        repository_id: repository.id,
        command_id: 'verify',
        purpose: 'verify',
        command: 'pnpm verify',
        timeout_ms: 900_000,
        expected_revision: repository.revision,
      });
      const listVerifyCommands = jest.spyOn(repositoryStore, 'listVerifyCommands');
      await sessionStore.createSession({
        tenant_id: TENANT_ID,
        session_id: 's1',
        created_by_subject: TEST_CREATED_BY_SUBJECT,
        agent: { type: 'inline', spec: agentSpec },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await modelProviderStore.upsertProvider({
        tenant_id: 'default',
        name: 'test-provider',
        manifest: {
          // Caller-named, so `custom` is the only type it can be.
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

      let releaseRest: (() => void) | undefined;
      const restParked = new Promise<void>(resolve => {
        releaseRest = resolve;
      });

      const sessions = {
        get: () =>
          Promise.resolve({
            session_id: 's1',
            tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
            spec: agentSpec,
            record: {
              last_turn_id: null,
              created_by_subject: TEST_CREATED_BY_SUBJECT,
              repository_id: repository.id,
              workspace_cwd: 'C:\\work\\bound-demo',
              agent: { type: 'inline', spec: agentSpec },
            },
            answersOnlyHeldActions: () => Promise.resolve(false),
            createTurn: () =>
              Promise.resolve({
                id: 'turn-non-stream',
                record: {
                  turn_id: 'turn-non-stream',
                  session_id: 's1',
                  previous_turn_id: null,
                  input: [],
                  state: { status: 'running' },
                  created_at: new Date('2026-01-01T00:00:00.000Z'),
                },
                stream: async function* stream() {
                  yield {
                    type: 'turn.created',
                    id: 'evt_created',
                    turn_id: 'turn-non-stream',
                    previous_turn_id: null,
                    state: { status: 'running' },
                    created_at: '2026-01-01T00:00:00.000Z',
                    thread_id: null,
                  };
                  await restParked;
                },
              }),
          }),
      } as unknown as Sessions<SessionCustom, TurnCustom>;

      const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore,
          resolveModelProviderStore: () => modelProviderStore,
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveAgentStore: () => new SqliteAgentStore(db),
          resolveSkillStore: () => new SqliteSkillStore(db),
          personalizationStore: new SqlitePersonalizationStore(db),
          personaStore: new SqlitePersonaStore(db),
          spaceStore: new SqliteSpaceStore(db),
          repositoryStore,
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          eventSubscriptions,
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger,
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') ?? '').toContain('application/json');
      const body: unknown = await response.json();
      expect(body).toEqual({
        data: {
          id: 'turn-non-stream',
          session_id: 's1',
          previous_turn_id: null,
          input: [],
          state: { status: 'running' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(listVerifyCommands).toHaveBeenCalledWith({
        tenant_id: TENANT_ID,
        created_by: TEST_CREATED_BY,
        repository_id: repository.id,
      });

      // Resumable stream must exist before the JSON response returns.
      await expect(
        eventSubscriptions.get(turnStreamId('default', 's1', 'turn-non-stream')).assertSubscribable(),
      ).resolves.toBeUndefined();

      releaseRest?.();
    });

    it('still creates the turn when the learning pass cannot resolve the turn model', async () => {
      const logger = createLogger({ silent: true });
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      // The profile carries the learning switch, so the pass only runs for a user who turned
      // it on; without this row the create path would skip the model lookup entirely.
      const personalizationStore = new SqlitePersonalizationStore(db);
      await personalizationStore.upsertProfile({
        tenant_id: TENANT_ID,
        created_by: TEST_CREATED_BY,
        updated_by: TEST_CREATED_BY,
        assistant_name: null,
        assistant_identity: null,
        voice_guidance: null,
        user_name: null,
        address_as: null,
        user_profile: null,
        pinned_preferences: [],
        learned_profile: null,
        learning_enabled: true,
      });
      const sessionStore = new SqliteSessionStore(db);
      // A reference agent, so the pass has to ask the agent store for the turn's model.
      const agentStore = new SqliteAgentStore(db);
      const referencedAgent = await agentStore.createAgent({
        tenant_id: TENANT_ID,
        name: 'learning-agent',
        description: 'Test agent.',
        manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
        external_id: 'learning-agent-external',
        created_by_subject: TEST_CREATED_BY_SUBJECT,
      });
      await sessionStore.createSession({
        tenant_id: TENANT_ID,
        session_id: 's1',
        created_by_subject: TEST_CREATED_BY_SUBJECT,
        agent: { type: 'reference', id: referencedAgent.id, name: referencedAgent.name },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      // The route itself resolves the referenced agent once, up front, for authorization; that
      // lookup must succeed. The pass resolves a reference agent's model again before the turn
      // exists; that second read is the only part of learning on the create path, and it must
      // never fail the turn.
      const getAgent = jest
        .spyOn(agentStore, 'getAgent')
        .mockResolvedValueOnce(referencedAgent)
        .mockRejectedValue(new Error('agent store offline'));

      let releaseRest: (() => void) | undefined;
      const restParked = new Promise<void>(resolve => {
        releaseRest = resolve;
      });

      const sessions = await scriptedSessions({
        sessionStore,
        sessionId: 's1',
        turnId: 'turn-learning-degraded',
        stream: async function* stream() {
          yield {
            type: 'turn.created',
            id: 'evt_created',
            turn_id: 'turn-learning-degraded',
            previous_turn_id: null,
            state: { status: 'running' },
            created_at: '2026-01-01T00:00:00.000Z',
            thread_id: null,
          };
          await restParked;
        },
      });

      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore: new SqliteOAuthTokenStore(db),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveAgentStore: () => agentStore,
          resolveSkillStore: () => new SqliteSkillStore(db),
          personalizationStore,
          personaStore: new SqlitePersonaStore(db),
          spaceStore: new SqliteSpaceStore(db),
          repositoryStore: new SqliteRepositoryStore(db),
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger,
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, input: [{ type: EventType.USER_MESSAGE, content: 'Hello.' }] }),
      });

      expect(getAgent).toHaveBeenCalled();
      expect(response.status).toBe(200);
      const body = GetTurnResponseSchema.parse(await response.json());
      expect(body.data.id).toBe('turn-learning-degraded');

      releaseRest?.();
    });
  });

  describe('turn SSE after session deletion', () => {
    it('warns when the stream ends because the session/turn was removed', async () => {
      const warnings: unknown[] = [];
      const logger = createLogger({ silent: true });
      logger.warn = ((message: unknown) => {
        warnings.push(message);
        return logger;
      }) as typeof logger.warn;

      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const modelProviderStore = new SqliteModelProviderStore(db);
      const sessionStore = new SqliteSessionStore(db);
      await modelProviderStore.upsertProvider({
        tenant_id: 'default',
        name: 'test-provider',
        manifest: {
          // Caller-named, so `custom` is the only type it can be.
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

      const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
      await sessionStore.createSession({
        tenant_id: TENANT_ID,
        session_id: 's1',
        created_by_subject: TEST_CREATED_BY_SUBJECT,
        agent: { type: 'inline', spec: agentSpec },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const sessions = {
        get: () =>
          Promise.resolve({
            session_id: 's1',
            tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
            spec: agentSpec,
            record: {
              session_id: 's1',
              last_turn_id: null,
              created_by_subject: TEST_CREATED_BY_SUBJECT,
              repository_id: null,
              workspace_cwd: null,
              agent: { type: 'inline', spec: agentSpec },
            },
            answersOnlyHeldActions: () => Promise.resolve(false),
            createTurn: () =>
              Promise.resolve({
                id: 'turn-gone',
                stream: async function* stream() {
                  throw new TurnNotFoundError('turn-gone');
                },
              }),
          }),
      } as unknown as Sessions<SessionCustom, TurnCustom>;

      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore,
          resolveModelProviderStore: () => modelProviderStore,
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          personalizationStore: new SqlitePersonalizationStore(db),
          personaStore: new SqlitePersonaStore(db),
          spaceStore: new SqliteSpaceStore(db),
          repositoryStore: new SqliteRepositoryStore(db),
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger,
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(
        warnings.some(
          message =>
            typeof message === 'string' && message.includes('Turn stream ended after session/turn was removed'),
        ),
      ).toBe(true);
    });
  });

  describe('create turn referenced agent', () => {
    const deniedCanAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) =>
      Promise.resolve(false),
    );
    const denyAllAuthorizer: Authorizer = {
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent: deniedCanAccessAgent,
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    };

    async function referencedAgentHarness(authorizer: Authorizer) {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      const agentStore = new SqliteAgentStore(db);
      const agent = await agentStore.createAgent({
        tenant_id: 'default',
        created_by_subject: {
          subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
          subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
          subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
        },
        name: 'named-for-turn',
        description: 'Test agent.',
        manifest: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
        }),
        external_id: null,
      });
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: {
          subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
          subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
          subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
        },
        agent: { type: 'reference', id: agent.id, name: agent.name },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore,
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => agentStore,
          personalizationStore: new SqlitePersonalizationStore(db),
          personaStore: new SqlitePersonaStore(db),
          spaceStore: new SqliteSpaceStore(db),
          repositoryStore: new SqliteRepositoryStore(db),
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer,
        }),
      );
      return { app, agent, agentStore };
    }

    it('returns 422 when the referenced agent no longer exists', async () => {
      const { app, agent, agentStore } = await referencedAgentHarness(new TrueForgeAuthorizer());
      await agentStore.deleteAgent({ tenant_id: 'default', id: agent.id });
      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { message: `Agent not found: ${agent.id}` } });
    });

    it('returns 404 when the caller cannot use the referenced agent', async () => {
      deniedCanAccessAgent.mockClear();
      const { app, agent } = await referencedAgentHarness(denyAllAuthorizer);
      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { message: `Agent not found: ${agent.id}` } });
      expect(deniedCanAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
    });
  });
});
