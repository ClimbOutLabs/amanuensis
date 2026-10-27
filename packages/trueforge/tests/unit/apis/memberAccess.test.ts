/**
 * What a signed-in member (non-admin) can and cannot do over the real HTTP surface of a hosted deployment, where
 * several people share one server: they chat, but cannot change server settings, connectors, providers or the
 * sandbox, and never see another person's sessions.
 */
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const OWNER = 'owner@demo.example';
const JUDGE = 'judge1@demo.example';
const OTHER_JUDGE = 'judge2@demo.example';

/** The caller is named by `x-test-user`; only the owner carries the admin role. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: 'default',
      subject: { id: user, type: 'user', display_name: user },
      roles: user === OWNER ? ['admin'] : [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function as(user: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', user);
  if (init?.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return { ...init, headers };
}

// Every settings area an admin manages: model providers, connectors, skills, sandbox, run code and the screens.
const SETTINGS_PATHS = [
  '/api/v1/settings/model-providers',
  '/api/v1/settings/mcp-servers',
  '/api/v1/settings/skills',
  '/api/v1/settings/sandbox-providers',
  '/api/v1/settings/run-code',
  '/api/v1/settings/tool-output-screens',
  '/api/v1/settings/memory-screens',
  '/api/v1/settings/memory-summarize',
  '/api/v1/settings/anything-added-later',
];
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('a member (non-admin) over HTTP', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function createSession(user: string): Promise<string> {
    const response = await server.request(
      '/api/v1/sessions',
      as(user, { method: 'POST', body: JSON.stringify({ agent: { spec: AGENT_SPEC } }) }),
    );
    expect(response.status).toBe(201);
    return z.object({ data: z.object({ id: z.string() }).loose() }).parse(await response.json()).data.id;
  }

  describe('server settings', () => {
    it.each(SETTINGS_PATHS)('refuses a member on %s for reads and every kind of write', async path => {
      for (const method of ['GET', ...WRITE_METHODS]) {
        const body = method === 'GET' ? undefined : JSON.stringify({});
        const response = await server.request(path, as(JUDGE, { method, ...(body === undefined ? {} : { body }) }));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: { message: 'Admin access required' } });
      }
    });

    it.each(SETTINGS_PATHS.slice(0, -1))('lets the owner reach %s', async path => {
      const response = await server.request(path, as(OWNER));
      expect([401, 403]).not.toContain(response.status);
    });

    // The Email and Calendar accounts belong to the whole instance, so only an admin may read or change them.
    const ACCOUNT_ROUTES: { method: string; path: string }[] = ['email', 'calendar'].flatMap(kind => [
      { method: 'GET', path: `/api/v1/user/settings/${kind}/status` },
      { method: 'POST', path: `/api/v1/user/settings/${kind}` },
      { method: 'DELETE', path: `/api/v1/user/settings/${kind}` },
    ]);

    it.each(ACCOUNT_ROUTES)('refuses a member on $method $path', async ({ method, path }) => {
      const body = method === 'GET' ? undefined : JSON.stringify({});
      const response = await server.request(path, as(JUDGE, { method, ...(body === undefined ? {} : { body }) }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { message: 'Admin access required' } });
    });

    it.each(['email', 'calendar'])('lets the owner reach the %s status', async kind => {
      const response = await server.request(`/api/v1/user/settings/${kind}/status`, as(OWNER));
      expect(response.status).toBe(200);
    });

    it('refuses an unauthenticated caller before any role check', async () => {
      const response = await server.request('/api/v1/settings/model-providers');
      expect(response.status).toBe(401);
    });

    it('does not let a member add or change a connector through the member-facing connector routes', async () => {
      const manifest = { type: 'remote', name: 'sneaky', url: 'https://sneaky.example.invalid/mcp', description: 'x' };
      for (const method of ['POST', 'PUT']) {
        const response = await server.request(
          '/api/v1/mcp-servers',
          as(JUDGE, { method, body: JSON.stringify({ manifest }) }),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      const deleted = await server.request('/api/v1/mcp-servers/inert', as(JUDGE, { method: 'DELETE' }));
      expect(deleted.status).toBeGreaterThanOrEqual(400);
      const listed = await server.request('/api/v1/settings/mcp-servers', as(OWNER));
      expect(JSON.stringify(await listed.json())).not.toContain('sneaky');
    });

    it('tells the UI a member has no settings, and withholds server paths', async () => {
      const member = z
        .object({
          data: z
            .object({ settings: z.object({ enabled: z.boolean() }), memory_defaults: z.object({}).loose() })
            .loose(),
        })
        .parse(await (await server.request('/api/v1/capabilities', as(JUDGE))).json());
      expect(member.data.settings.enabled).toBe(false);
      expect(member.data.memory_defaults).not.toHaveProperty('markdown_dir');

      const owner = z
        .object({ data: z.object({ settings: z.object({ enabled: z.boolean() }) }).loose() })
        .parse(await (await server.request('/api/v1/capabilities', as(OWNER))).json());
      expect(owner.data.settings.enabled).toBe(true);
    });
  });

  describe('chat and sessions', () => {
    it('lets a member start a chat and read it back', async () => {
      const id = await createSession(JUDGE);
      const response = await server.request(`/api/v1/sessions/${id}`, as(JUDGE));
      expect(response.status).toBe(200);
    });

    it("keeps one person's sessions from another, in lists and by id", async () => {
      const ownerSession = await createSession(OWNER);
      const judgeSession = await createSession(JUDGE);

      const otherReads = await server.request(`/api/v1/sessions/${ownerSession}`, as(JUDGE));
      expect(otherReads.status).toBe(403);
      const ownerReadsJudge = await server.request(`/api/v1/sessions/${judgeSession}`, as(OWNER));
      expect(ownerReadsJudge.status).toBe(403);
      const secondJudgeReads = await server.request(`/api/v1/sessions/${judgeSession}`, as(OTHER_JUDGE));
      expect(secondJudgeReads.status).toBe(403);

      const listed = z
        .object({ data: z.array(z.object({ id: z.string() }).loose()) })
        .parse(await (await server.request('/api/v1/sessions', as(JUDGE))).json());
      const ids = listed.data.map(session => session.id);
      expect(ids).toContain(judgeSession);
      expect(ids).not.toContain(ownerSession);
    });

    it("refuses a member another person's session on mutation and on the live event stream", async () => {
      const ownerSession = await createSession(OWNER);
      const cancel = await server.request(`/api/v1/sessions/${ownerSession}/cancel`, as(JUDGE, { method: 'POST' }));
      expect(cancel.status).toBe(403);
      const events = await server.request(`/api/v1/sessions/${ownerSession}/events`, as(JUDGE));
      expect(events.status).toBe(403);
      const removed = await server.request(`/api/v1/sessions/${ownerSession}`, as(JUDGE, { method: 'DELETE' }));
      expect(removed.status).toBe(403);
      const stillThere = await server.request(`/api/v1/sessions/${ownerSession}`, as(OWNER));
      expect(stillThere.status).toBe(200);
    });
  });
});
