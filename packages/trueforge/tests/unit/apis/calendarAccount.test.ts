import { CALDAV_PROVIDER_PRESETS } from '@truefoundry/trueforge-core/core/calendar/caldav/presets';
import { Hono } from 'hono';
import { createLogger } from 'winston';
import { CALENDAR_SETTINGS_BASE_PATH, createCalendarAccountRouter } from '../../../src/apis/calendarAccount';
import configuration from '../../../src/config';
import type {
  DeleteMcpServerInput,
  IMcpServerStore,
  McpServerRecord,
  UpsertMcpServerInput,
} from '../../../src/db/mcpServerStore';
import {
  CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE,
  CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE,
  CALENDAR_DETAILS_UNUSABLE_MESSAGE,
  CALENDAR_SERVER_UNREACHABLE_MESSAGE,
  CALENDAR_SIGN_IN_REFUSED_MESSAGE,
  CALENDAR_STATUS_UNREACHABLE_MESSAGE,
} from '../../../src/runtime/calendarAccount';

const BASE = CALENDAR_SETTINGS_BASE_PATH;
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const ACCOUNT_URL = 'http://calendar-caldav:9560';
const MCP_URL = 'http://calendar-caldav:9558/mcp';
const EMAIL = 'owner@example.invalid';

type AgentReply = { status: number; body: unknown };

/** One recorded call to the fake account agent. */
type AgentCall = { method: string; url: string; body: string | undefined };

/** The agent the server proxies to: answers from a script and records every call. */
function makeFakeAgent() {
  const calls: AgentCall[] = [];
  let replies: AgentReply[] = [];
  const fetchImpl = async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error('the fake agent ran out of replies');
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    fetchImpl,
    script: (next: AgentReply[]) => {
      replies = [...next];
    },
  };
}

/** The flat status body the account agent answers with. */
type AgentBody = Record<string, unknown>;

const NOT_CONNECTED: AgentBody = { connected: false };

/** A connected agent body for a typed calendar address. */
const CONNECTED: AgentBody = {
  connected: true,
  url: 'https://nas.example.invalid/dav/',
  username: 'owner@example.invalid',
  email: 'owner@example.invalid',
  sign_in: 'ok',
};

/** A fake MCP store for the connector registration the save and remove handlers keep in step. */
function makeFakeStore() {
  const rows = new Map<string, UpsertMcpServerInput>();
  const store: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'> = {
    upsertServer: (input: UpsertMcpServerInput): Promise<McpServerRecord> => {
      rows.set(`${input.tenant_id}:${String(input.name)}`, input);
      return Promise.resolve({
        id: 'fake-id',
        tenant_id: input.tenant_id,
        name: input.name,
        manifest: input.manifest,
        first_party: input.first_party,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    },
    deleteServer: (input: DeleteMcpServerInput): Promise<boolean> =>
      Promise.resolve(rows.delete(`${input.tenant_id}:${input.name}`)),
  };
  return { rows, store };
}

describe('the calendar settings endpoints', () => {
  const originalAccountUrl = configuration.CALENDAR_ACCOUNT_URL;
  const originalConnectorUrl = configuration.CALENDAR_CONNECTOR_URL;
  let agent: ReturnType<typeof makeFakeAgent>;
  let fakeStore: ReturnType<typeof makeFakeStore>;
  let app: Hono;

  beforeEach(() => {
    agent = makeFakeAgent();
    fakeStore = makeFakeStore();
    configuration.CALENDAR_ACCOUNT_URL = ACCOUNT_URL;
    configuration.CALENDAR_CONNECTOR_URL = undefined;
    const router = createCalendarAccountRouter({
      resolveRequestContext: () => ({
        tenant_id: 't1',
        subject: { id: 'owner-1', type: 'user', display_name: 'owner-1' },
        roles: [],
        user_credential: null,
      }),
      logger: createLogger({ silent: true }),
      fetchImpl: agent.fetchImpl,
      mcpServerStore: fakeStore.store,
    });
    app = new Hono();
    app.route(BASE, router);
  });

  afterEach(() => {
    configuration.CALENDAR_ACCOUNT_URL = originalAccountUrl;
    configuration.CALENDAR_CONNECTOR_URL = originalConnectorUrl;
  });

  async function call(input: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
    origin?: string;
  }): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {};
    if (input.contentType !== undefined) {
      headers['content-type'] = input.contentType;
    } else if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (input.origin !== undefined) {
      headers['origin'] = input.origin;
    }
    // The save and remove routes sit on the base path itself, with no trailing slash.
    const suffix = input.path === '/' ? '' : input.path;
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) {
      init.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    }
    const response = await app.request(`http://localhost${BASE}${suffix}`, init);
    return { status: response.status, text: await response.text() };
  }

  it('reports Not connected, with the provider list and the help for each, when no account is saved', async () => {
    agent.script([{ status: 200, body: NOT_CONNECTED }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    const data = JSON.parse(text).data;
    expect(data.available).toBe(true);
    expect(data.state).toBe('not_connected');
    expect(data.email).toBeNull();
    expect(data.providers.map((provider: { key: string }) => provider.key)).toEqual([
      'fastmail',
      'yahoo',
      'gmx',
      'webde',
      'other',
    ]);
    expect(data.providers).toEqual(
      CALDAV_PROVIDER_PRESETS.map(preset => ({
        key: preset.key,
        name: preset.name,
        server_url: preset.server_url,
        help_url: preset.help_url,
        help_hint: preset.help_hint,
      })),
    );
  });

  it('reports Connected with the email, and never the password', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, password: CANARY } }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY);
    const data = JSON.parse(text).data;
    expect(data.state).toBe('connected');
    expect(data.email).toBe(EMAIL);
    expect(data.provider_key).toBe('other');
  });

  it('works the provider out from the saved address', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, url: 'https://caldav.fastmail.com/dav/' } }]);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.provider_key).toBe('fastmail');
  });

  it('reports a stopped sign-in in plain words', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, sign_in: 'refused' } }]);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.state).toBe('sign_in_stopped');
  });

  it('hides the card when the instance has no calendar connector to configure', async () => {
    configuration.CALENDAR_ACCOUNT_URL = undefined;
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.available).toBe(false);
    expect(agent.calls).toHaveLength(0);
  });

  it('fails the status plainly when the connector cannot be reached', async () => {
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
  });

  it('fails the status plainly when the connector answers with an error', async () => {
    agent.script([{ status: 500, body: { error: 'boom' } }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_STATUS_UNREACHABLE_MESSAGE);
  });

  it('saves a Fastmail login with the built-in address, and registers the connector', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, url: 'https://caldav.fastmail.com/dav/' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: 'abcd-efgh-ijkl-mnop' },
    });
    expect(status).toBe(201);
    expect(JSON.parse(text).data.state).toBe('connected');
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.url).toBe(`${ACCOUNT_URL}/account`);
    expect(JSON.parse(agent.calls[0]?.body ?? '{}')).toEqual({
      url: 'https://caldav.fastmail.com/dav/',
      username: EMAIL,
      password: 'abcd-efgh-ijkl-mnop',
      email: EMAIL,
    });
    const registered = [...fakeStore.rows.values()];
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('Calendar');
    expect(registered[0]?.first_party).toBe(true);
    expect(registered[0]?.manifest).toMatchObject({ type: 'remote', url: MCP_URL });
  });

  it('uses the GMX address for the email domain, and a typed login name when given', async () => {
    agent.script([{ status: 200, body: CONNECTED }]);
    await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmx', email: 'owner@gmx.net', password: 'abc123', username: 'owner-login' },
    });
    expect(JSON.parse(agent.calls[0]?.body ?? '{}')).toMatchObject({
      url: 'https://caldav.gmx.net/',
      username: 'owner-login',
    });
  });

  it('sends a typed address for Other, and only for Other', async () => {
    agent.script([{ status: 200, body: CONNECTED }]);
    const ok = await call({
      method: 'POST',
      path: '/',
      body: {
        provider_key: 'other',
        email: EMAIL,
        password: 'abc123',
        calendar_url: 'https://nas.example.invalid/dav/',
      },
    });
    expect(ok.status).toBe(201);
    expect(JSON.parse(agent.calls[0]?.body ?? '{}').url).toBe('https://nas.example.invalid/dav/');
    const stray = await call({
      method: 'POST',
      path: '/',
      body: {
        provider_key: 'fastmail',
        email: EMAIL,
        password: 'abc123',
        calendar_url: 'https://nas.example.invalid/',
      },
    });
    expect(stray.status).toBe(400);
    expect(agent.calls).toHaveLength(1);
  });

  it('refuses a bad address, a Gmail address, a missing or unusable calendar address and a bad password before the connector is asked', async () => {
    const cases: { body: Record<string, unknown>; says: string }[] = [
      {
        body: { provider_key: 'fastmail', email: 'nope', password: CANARY },
        says: 'does not look like an email address',
      },
      {
        body: { provider_key: 'fastmail', email: 'person@gmail.com', password: CANARY },
        says: 'use the Google connector',
      },
      { body: { provider_key: 'other', email: EMAIL, password: CANARY }, says: 'Type the calendar address' },
      {
        body: { provider_key: 'gmx', email: 'owner@gmx.de', password: CANARY },
        says: 'no built-in calendar address for gmx.de',
      },
      {
        body: { provider_key: 'other', email: EMAIL, password: CANARY, calendar_url: 'http://nas.example.invalid/' },
        says: 'must start with https://',
      },
      {
        body: { provider_key: 'other', email: EMAIL, password: CANARY, calendar_url: 'https://localhost/' },
        says: 'full server name',
      },
      { body: { provider_key: 'fastmail', email: EMAIL, password: "has a ' quote" }, says: 'cannot be saved' },
      { body: { provider_key: 'fastmail', email: EMAIL, password: 'has space' }, says: 'cannot be saved' },
      { body: { provider_key: 'nowhere', email: EMAIL, password: CANARY }, says: 'not on the list' },
    ];
    for (const { body, says } of cases) {
      const { status, text } = await call({ method: 'POST', path: '/', body });
      expect(status).toBe(400);
      expect(JSON.parse(text).error.message).toContain(says);
      expect(text).not.toContain(CANARY);
    }
    expect(agent.calls).toHaveLength(0);
    expect(fakeStore.rows.size).toBe(0);
  });

  it('a refused login shows the refused line and saves nothing', async () => {
    agent.script([{ status: 400, body: { error: 'sign_in_refused' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_SIGN_IN_REFUSED_MESSAGE);
    expect(text).not.toContain(CANARY);
    expect(fakeStore.rows.size).toBe(0);
  });

  it('an unreachable server and an address that is not allowed each show their own line', async () => {
    agent.script([
      { status: 400, body: { error: 'server_unreachable' } },
      { status: 400, body: { error: 'address_not_allowed' } },
    ]);
    const body = {
      provider_key: 'other',
      email: EMAIL,
      password: CANARY,
      calendar_url: 'https://nas.example.invalid/dav/',
    };
    const first = await call({ method: 'POST', path: '/', body });
    expect(first.status).toBe(400);
    expect(JSON.parse(first.text).error.message).toBe(CALENDAR_SERVER_UNREACHABLE_MESSAGE);
    const second = await call({ method: 'POST', path: '/', body });
    expect(second.status).toBe(400);
    expect(JSON.parse(second.text).error.message).toBe(CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE);
    expect(first.text + second.text).not.toContain(CANARY);
    expect(fakeStore.rows.size).toBe(0);
  });

  it('says the details cannot be saved when the connector finds them unusable', async () => {
    agent.script([{ status: 400, body: { error: 'invalid' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'other', email: EMAIL, password: CANARY, calendar_url: 'https://127.1/' },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_DETAILS_UNUSABLE_MESSAGE);
    expect(text).not.toContain(CANARY);
  });

  it('never repeats what the connector says back: a leaky error stays out of the response', async () => {
    agent.script([{ status: 500, body: { error: `boom while signing in with ${CANARY}` } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
    expect(text).not.toContain(CANARY);
  });

  it('a save answer that echoes the password is dropped by the status parser', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, password: CANARY, debug: CANARY } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(status).toBe(201);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text).data.email).toBe(EMAIL);
  });

  it('remove deletes the account and the connector registration', async () => {
    agent.script([
      { status: 200, body: CONNECTED },
      { status: 200, body: NOT_CONNECTED },
    ]);
    await call({ method: 'POST', path: '/', body: { provider_key: 'fastmail', email: EMAIL, password: CANARY } });
    expect(fakeStore.rows.size).toBe(1);
    const { status, text } = await call({ method: 'DELETE', path: '/', body: {} });
    expect(status).toBe(200);
    expect(JSON.parse(text).data.state).toBe('not_connected');
    expect(text).not.toContain(CANARY);
    expect(fakeStore.rows.size).toBe(0);
    expect(agent.calls[1]?.method).toBe('DELETE');
  });

  it('refuses a form post from another site: no JSON body, no save', async () => {
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: `provider_key=fastmail&email=${EMAIL}&password=${CANARY}`,
      contentType: 'application/x-www-form-urlencoded',
      origin: 'https://evil.example.net',
    });
    expect(status).toBe(403);
    expect(JSON.parse(text).error.type).toBe('cross_site_request');
    expect(agent.calls).toHaveLength(0);
  });

  it('refuses a bodiless remove from another site', async () => {
    const { status } = await call({ method: 'DELETE', path: '/', origin: 'https://evil.example.net' });
    expect(status).toBe(403);
    expect(agent.calls).toHaveLength(0);
  });
});
