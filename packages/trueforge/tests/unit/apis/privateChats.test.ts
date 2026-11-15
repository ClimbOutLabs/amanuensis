import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { createClient } from 'redis';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createChatPrivacyRouter, sweepExpiredPrivateChats } from '../../../src/apis/privateChats';
import { createSessionFolderAssignmentsRouter, createSessionFoldersRouter } from '../../../src/apis/sessionFolders';
import { createSessionsRouter, type SessionsRouterDeps } from '../../../src/apis/sessions';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT, type RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteChatDeletionStore } from '../../../src/db/sqlite/chat-deletion-store/SqliteChatDeletionStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import {
  PRIVATE_CHAT_FLAG_CHANGE_MESSAGE,
  PRIVATE_CHAT_FOLDER_MESSAGE,
  PRIVATE_CHAT_LIFETIME_MS,
} from '../../../src/runtime/privateChat';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { ListSessionsResponseSchema } from '../../../src/schemas/session';

const inlineSpec = AgentSpecSchema.parse({ model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: 'inline' });

const SessionResponseSchema = z.object({
  data: z.object({ id: z.string(), is_incognito: z.boolean(), private_expires_at: z.string().nullable() }),
});
const ErrorResponseSchema = z.object({ error: z.object({ message: z.string() }) });
const PrivacyResponseSchema = z.object({
  data: z.object({
    leaves_machine: z.boolean(),
    hosted_providers: z.array(z.object({ type: z.string(), name: z.string() })),
  }),
});

const OTHER_PERSON: RequestContext = {
  ...STANDALONE_REQUEST_CONTEXT,
  subject: { id: 'someone-else', type: 'user', display_name: 'someone-else' },
};

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('private chats over HTTP', () => {
  let app: OpenAPIHono;
  let sessionStore: SqliteSessionStore;
  let deps: SessionsRouterDeps;
  let caller: RequestContext;
  let modelProviderStore: SqliteModelProviderStore;

  beforeEach(async () => {
    caller = STANDALONE_REQUEST_CONTEXT;
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    sessionStore = new SqliteSessionStore(db);
    modelProviderStore = new SqliteModelProviderStore(db);
    const mcpServerStore = new SqliteMcpServerStore(db);
    const skillStore = new SqliteSkillStore(db);
    const sandboxProviderStore = new SqliteSandboxProviderStore(db);
    const agentStore = new SqliteAgentStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: 'default',
      name: 'anthropic',
      manifest: {
        type: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        auth: { api_key: 'sk-ant-invented' },
        models: [
          {
            model_id: 'claude-sonnet-4-6',
            name: 'claude-sonnet-4-6',
            properties: { context_length: 200000, max_output_tokens: 32768 },
          },
        ],
      },
    });
    deps = {
      chatDeletionStore: new SqliteChatDeletionStore({ db, turnArtifactStore: new SqliteTurnArtifactStore(db) }),
      turnDrains: new TurnDrainRegistry(),
      sessions: new Sessions({ sessionStore }),
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
      resolveRequestContext: () => caller,
      logger: createLogger({ silent: true }),
      authorizer: new TrueForgeAuthorizer(),
    };
    app = new OpenAPIHono();
    app.route('/', createSessionsRouter(deps));
    app.route(
      '/',
      createChatPrivacyRouter({
        sessionStore,
        personaStore: new SqlitePersonaStore(db),
        resolveAgentStore: () => agentStore,
        resolveModelProviderStore: () => modelProviderStore,
        resolveRequestContext: () => caller,
      }),
    );
    app.route(
      '/api/session-folders',
      createSessionFoldersRouter({ sessionStore, resolveRequestContext: () => caller }),
    );
    app.route('/', createSessionFolderAssignmentsRouter({ sessionStore, resolveRequestContext: () => caller }));
  });

  async function createChat(isIncognito: boolean): Promise<z.infer<typeof SessionResponseSchema>['data']> {
    const res = await app.request('/', jsonInit('POST', { agent: { spec: inlineSpec }, is_incognito: isIncognito }));
    expect(res.status).toBe(201);
    return SessionResponseSchema.parse(await res.json()).data;
  }

  async function listIds(query: string): Promise<string[]> {
    const res = await app.request(`/${query}`);
    expect(res.status).toBe(200);
    return ListSessionsResponseSchema.parse(await res.json()).data.map(session => session.id);
  }

  it('creates a private chat that expires a day after it starts', async () => {
    const before = Date.now();
    const chat = await createChat(true);

    expect(chat.is_incognito).toBe(true);
    const expiresAt = Date.parse(chat.private_expires_at ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + PRIVATE_CHAT_LIFETIME_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + PRIVATE_CHAT_LIFETIME_MS);

    const normal = await createChat(false);
    expect(normal).toMatchObject({ is_incognito: false, private_expires_at: null });
  });

  it('refuses to make a chat private, or normal, after it starts', async () => {
    const normal = await createChat(false);
    const privateChat = await createChat(true);

    for (const [id, flag] of [
      [normal.id, true],
      [privateChat.id, false],
    ] as const) {
      const res = await app.request(`/${id}`, jsonInit('PATCH', { is_incognito: flag }));
      expect(res.status).toBe(422);
      expect(ErrorResponseSchema.parse(await res.json()).error.message).toBe(PRIVATE_CHAT_FLAG_CHANGE_MESSAGE);
    }

    const unchanged = await app.request(`/${privateChat.id}`, jsonInit('PATCH', { is_incognito: true, title: 'Ok' }));
    expect(unchanged.status).toBe(200);
  });

  it('lists a private chat only when asked, and only to the person who started it', async () => {
    const normal = await createChat(false);
    const privateChat = await createChat(true);

    expect(await listIds('')).toEqual([normal.id]);
    expect((await listIds('?include_private=true')).sort()).toEqual([normal.id, privateChat.id].sort());

    caller = OTHER_PERSON;
    expect(await listIds('?include_private=true')).not.toContain(privateChat.id);
    expect((await app.request(`/${privateChat.id}`)).status).toBe(403);
  });

  it('deletes a private chat for real when it is closed, with the files its sandboxes hold', async () => {
    const privateChat = await createChat(true);
    const otherChat = await createChat(false);
    if (!configuration.STANDALONE) {
      throw new Error('local sandboxes need standalone mode, which the unit tests run in');
    }
    const standalone = configuration;
    const sandboxParent = await mkdtemp(path.join(tmpdir(), 'aman-sandboxes-'));
    const originalParent = standalone.LOCAL_SANDBOX_ROOT_PARENT;
    standalone.LOCAL_SANDBOX_ROOT_PARENT = sandboxParent;
    try {
      for (const chat of [privateChat, otherChat]) {
        await mkdir(path.join(sandboxParent, chat.id, 'sbx-1', 'work'), { recursive: true });
        await writeFile(path.join(sandboxParent, chat.id, 'sbx-1', 'work', 'notes.txt'), 'the private ferry plan');
      }

      const res = await app.request(`/${privateChat.id}`, { method: 'DELETE' });
      expect(res.status).toBeLessThan(300);

      expect(await sessionStore.getSession({ tenant_id: 'default', session_id: privateChat.id })).toBeUndefined();
      expect((await app.request(`/${privateChat.id}`)).status).toBe(404);
      expect(await readdir(sandboxParent)).toEqual([otherChat.id]);
    } finally {
      standalone.LOCAL_SANDBOX_ROOT_PARENT = originalParent;
      await rm(sandboxParent, { recursive: true, force: true });
    }
  });

  it('refuses to put a private chat in a folder', async () => {
    const privateChat = await createChat(true);
    const folderRes = await app.request('/api/session-folders', jsonInit('POST', { name: 'Trips' }));
    const folder = z.object({ data: z.object({ id: z.string() }) }).parse(await folderRes.json()).data;

    const res = await app.request(`/${privateChat.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));

    expect(res.status).toBe(422);
    expect(ErrorResponseSchema.parse(await res.json()).error.message).toBe(PRIVATE_CHAT_FOLDER_MESSAGE);
  });

  it('sweeps away only the private chats whose time is up', async () => {
    const expired = await createChat(true);
    const open = await createChat(true);
    const normal = await createChat(false);
    await sessionStore.setPrivateExpiry({
      tenant_id: 'default',
      session_id: expired.id,
      private_expires_at: new Date(Date.now() - 1000),
    });

    expect(await sweepExpiredPrivateChats(deps, { now: new Date() })).toBe(1);

    expect(await sessionStore.getSession({ tenant_id: 'default', session_id: expired.id })).toBeUndefined();
    for (const id of [open.id, normal.id]) {
      expect(await sessionStore.getSession({ tenant_id: 'default', session_id: id })).toBeDefined();
    }
    expect(await sweepExpiredPrivateChats(deps, { now: new Date() })).toBe(0);
  });

  it('says a chat answered by a hosted model leaves the machine, naming the provider', async () => {
    const privateChat = await createChat(true);

    const res = await app.request(`/${privateChat.id}/privacy`);

    expect(res.status).toBe(200);
    expect(PrivacyResponseSchema.parse(await res.json()).data).toEqual({
      leaves_machine: true,
      hosted_providers: [{ type: 'anthropic', name: 'anthropic' }],
    });
  });
});
