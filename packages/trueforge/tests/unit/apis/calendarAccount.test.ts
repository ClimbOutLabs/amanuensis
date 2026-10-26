import { CALDAV_PROVIDER_PRESETS } from '@truefoundry/trueforge-core/core/calendar/caldav/presets';
import { Hono } from 'hono';
import { createLogger } from 'winston';
import { CALENDAR_SETTINGS_BASE_PATH, createCalendarAccountRouter } from '../../../src/apis/calendarAccount';
import configuration, { firstPartyOriginsFor, hostCalendarMcpUrl } from '../../../src/config';
import type {
  DeleteMcpServerInput,
  GetMcpServerInput,
  IMcpServerStore,
  McpServerRecord,
  UpsertMcpServerInput,
} from '../../../src/db/mcpServerStore';
import { isFirstPartyOrigin } from '../../../src/mcp/firstParty';
import { isHostOwnConnector, setUpConnectorNamesOf } from '../../../src/mcp/hostConnectors';
import {
  CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE,
  CALENDAR_CERTIFICATE_MESSAGE,
  CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE,
  CALENDAR_DETAILS_UNUSABLE_MESSAGE,
  CALENDAR_REDIRECT_MESSAGE,
  CALENDAR_SERVER_UNREACHABLE_MESSAGE,
  CALENDAR_SIGN_IN_REFUSED_MESSAGE,
  CALENDAR_STATUS_UNREACHABLE_MESSAGE,
} from '../../../src/runtime/calendarAccount';

const BASE = CALENDAR_SETTINGS_BASE_PATH;
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const ACCOUNT_URL = 'http://calendar-caldav:9560';
const MCP_URL = 'http://calendar-caldav:9558/mcp';
const EMAIL = 'owner@example.invalid';
const SECRET = 'test-account-secret-0123456789abcdef0123';

/** A scripted answer, or a request that fails before any answer, as a timeout does. */
type AgentReply = { status: number; body: unknown } | { fails: true };

/** One recorded call to the fake account agent. */
type AgentCall = { method: string; url: string; body: string | undefined; authorization: string | undefined };

/** The agent the server proxies to: answers from a script and records every call. */
function makeFakeAgent() {
  const calls: AgentCall[] = [];
  let replies: AgentReply[] = [];
  const fetchImpl = async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization,
    });
    const reply = replies.shift();
    if (reply === undefined || 'fails' in reply) {
      throw new Error('the fake agent could not answer');
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

/** A fake MCP store for the connector registration the handlers keep in step; `failing` makes writes throw. */
function makeFakeStore() {
  const rows = new Map<string, UpsertMcpServerInput>();
  const control = { failing: false };
  const record = (input: UpsertMcpServerInput): McpServerRecord => ({
    id: 'fake-id',
    tenant_id: input.tenant_id,
    name: input.name,
    manifest: input.manifest,
    first_party: input.first_party,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const store: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer' | 'getServer'> = {
    upsertServer: (input: UpsertMcpServerInput): Promise<McpServerRecord> => {
      if (control.failing) {
        return Promise.reject(new Error('the store is down'));
      }
      rows.set(`${input.tenant_id}:${String(input.name)}`, input);
      return Promise.resolve(record(input));
    },
    getServer: (input: GetMcpServerInput): Promise<McpServerRecord | undefined> => {
      const row = rows.get(`${input.tenant_id}:${input.name}`);
      return Promise.resolve(row === undefined ? undefined : record(row));
    },
    deleteServer: (input: DeleteMcpServerInput): Promise<boolean> =>
      Promise.resolve(rows.delete(`${input.tenant_id}:${input.name}`)),
  };
  return { rows, store, control };
}

describe('the calendar settings endpoints', () => {
  const originalAccountUrl = configuration.CALENDAR_ACCOUNT_URL;
  const originalSidecarUrl = configuration.CALENDAR_SIDECAR_MCP_URL;
  const originalSecret = configuration.CALENDAR_ACCOUNT_SECRET;
  let agent: ReturnType<typeof makeFakeAgent>;
  let fakeStore: ReturnType<typeof makeFakeStore>;
  let app: Hono;

  beforeEach(() => {
    agent = makeFakeAgent();
    fakeStore = makeFakeStore();
    configuration.CALENDAR_ACCOUNT_URL = ACCOUNT_URL;
    configuration.CALENDAR_ACCOUNT_SECRET = SECRET;
    configuration.CALENDAR_SIDECAR_MCP_URL = MCP_URL;
    const router = createCalendarAccountRouter({
      logger: createLogger({ silent: true }),
      fetchImpl: agent.fetchImpl,
      mcpServerStore: fakeStore.store,
    });
    app = new Hono();
    app.route(BASE, router);
  });

  afterEach(() => {
    configuration.CALENDAR_ACCOUNT_URL = originalAccountUrl;
    configuration.CALENDAR_SIDECAR_MCP_URL = originalSidecarUrl;
    configuration.CALENDAR_ACCOUNT_SECRET = originalSecret;
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
      { body: { provider_key: 'fastmail', email: EMAIL, password: '' }, says: 'app password is needed' },
      {
        body: { provider_key: 'fastmail', email: 'a\u0001b@example.invalid', password: CANARY },
        says: 'character that cannot be saved',
      },
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

  it('presents the instance secret to the agent on every call, and nothing else as a credential', async () => {
    agent.script([
      { status: 200, body: NOT_CONNECTED },
      { status: 200, body: CONNECTED },
      { status: 200, body: NOT_CONNECTED },
    ]);
    await call({ method: 'GET', path: '/status' });
    await call({ method: 'POST', path: '/', body: { provider_key: 'fastmail', email: EMAIL, password: CANARY } });
    await call({ method: 'DELETE', path: '/', body: {} });
    expect(agent.calls.map(sent => sent.authorization)).toEqual(Array(3).fill(`Bearer ${SECRET}`));
    expect(agent.calls.map(sent => sent.url).join(' ')).not.toContain(SECRET);
  });

  it('leaves the card off while the agent has no secret to answer to', async () => {
    configuration.CALENDAR_ACCOUNT_SECRET = undefined;
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.available).toBe(false);
    expect(agent.calls).toHaveLength(0);
  });

  it('gives the saved address and login back for the form, and never the password', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, username: 'owner-login', password: CANARY } }]);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(text).not.toContain(CANARY);
    const data = JSON.parse(text).data;
    expect(data.calendar_url).toBe('https://nas.example.invalid/dav/');
    expect(data.username).toBe('owner-login');
    expect(data.email).toBe(EMAIL);
  });

  it('says not working when the saved account cannot be signed in to right now, and keeps the connector', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, sign_in: 'unreachable' } }]);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.state).toBe('not_working');
    expect(fakeStore.rows.size).toBe(1);
  });

  it('keeps the connector registered when a saved login is refused on a status read, and shows the stopped state', async () => {
    agent.script([
      { status: 200, body: CONNECTED },
      { status: 200, body: { ...CONNECTED, sign_in: 'refused' } },
    ]);
    await call({ method: 'GET', path: '/status' });
    expect(fakeStore.rows.size).toBe(1);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.state).toBe('sign_in_stopped');
    expect(fakeStore.rows.size).toBe(1);
  });

  it('registers nothing for a save the server refuses', async () => {
    agent.script([{ status: 400, body: { error: 'sign_in_refused' } }]);
    await call({ method: 'POST', path: '/', body: { provider_key: 'fastmail', email: EMAIL, password: CANARY } });
    expect(fakeStore.rows.size).toBe(0);
  });

  it('every status read settles the registration from what the agent holds', async () => {
    agent.script([
      { status: 200, body: CONNECTED },
      { status: 200, body: NOT_CONNECTED },
    ]);
    await call({ method: 'GET', path: '/status' });
    expect([...fakeStore.rows.values()].map(row => row.name)).toEqual(['Calendar']);
    await call({ method: 'GET', path: '/status' });
    expect(fakeStore.rows.size).toBe(0);
  });

  it("never removes a connector named Calendar that is not the calendar sidecar's own", async () => {
    await fakeStore.store.upsertServer({
      tenant_id: 'default',
      name: 'Calendar',
      manifest: { type: 'remote', name: 'Calendar', url: 'https://mine.example.invalid/mcp', description: 'mine' },
      first_party: false,
    });
    agent.script([{ status: 200, body: NOT_CONNECTED }]);
    await call({ method: 'GET', path: '/status' });
    expect(fakeStore.rows.size).toBe(1);
  });

  it('a save the connector registration could not follow still answers connected, and the next status read attaches it', async () => {
    fakeStore.control.failing = true;
    agent.script([{ status: 200, body: CONNECTED }]);
    const saved = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(saved.status).toBe(201);
    expect(fakeStore.rows.size).toBe(0);
    fakeStore.control.failing = false;
    agent.script([{ status: 200, body: CONNECTED }]);
    await call({ method: 'GET', path: '/status' });
    expect(fakeStore.rows.size).toBe(1);
  });

  it('a save that timed out asks the agent what it really holds, and attaches the connector when it saved', async () => {
    agent.script([{ fails: true }, { status: 200, body: CONNECTED }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
    expect(text).not.toContain(CANARY);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]?.method).toBe('GET');
    expect(fakeStore.rows.size).toBe(1);
  });

  it('a removal that timed out asks the agent again, and detaches the connector when it was removed', async () => {
    agent.script([{ status: 200, body: CONNECTED }]);
    await call({ method: 'GET', path: '/status' });
    expect(fakeStore.rows.size).toBe(1);
    agent.script([{ fails: true }, { status: 200, body: NOT_CONNECTED }]);
    const { status } = await call({ method: 'DELETE', path: '/', body: {} });
    expect(status).toBe(502);
    expect(fakeStore.rows.size).toBe(0);
  });

  it('names a certificate the server did not accept and a redirect to another server, each with one next step', async () => {
    agent.script([
      { status: 400, body: { error: 'certificate_refused' } },
      { status: 400, body: { error: 'redirected' } },
    ]);
    const body = {
      provider_key: 'other',
      email: EMAIL,
      password: CANARY,
      calendar_url: 'https://nas.example.invalid/dav/',
    };
    const first = await call({ method: 'POST', path: '/', body });
    expect(JSON.parse(first.text).error.message).toBe(CALENDAR_CERTIFICATE_MESSAGE);
    const second = await call({ method: 'POST', path: '/', body });
    expect(JSON.parse(second.text).error.message).toBe(CALENDAR_REDIRECT_MESSAGE);
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
  });

  it('says which value the connector refused, without repeating it', async () => {
    agent.script([{ status: 400, body: { error: 'invalid', field: 'password' } }]);
    const { text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(JSON.parse(text).error.message).toContain('app password has a character that cannot be saved');
    expect(text).not.toContain(CANARY);
  });

  it("a calendar saved through the account agent is the host's own: attached by default and first-party, with no connector link set", async () => {
    // The installer links only the account agent, so the sidecar address is the one derived from it, as config.ts resolves it.
    configuration.CALENDAR_SIDECAR_MCP_URL = hostCalendarMcpUrl({
      calendarMcpUrl: undefined,
      calendarAccountUrl: ACCOUNT_URL,
    });
    agent.script([{ status: 200, body: CONNECTED }]);
    const saved = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'fastmail', email: EMAIL, password: CANARY },
    });
    expect(saved.status).toBe(201);
    const row = [...fakeStore.rows.values()][0];
    if (row?.manifest.type !== 'remote') {
      throw new Error('the Calendar connector was not registered as a remote connector');
    }
    expect(row.manifest.url).toBe(MCP_URL);
    expect(row.first_party).toBe(true);
    expect(isHostOwnConnector({ name: 'Calendar', url: row.manifest.url })).toBe(true);
    // Attached by default, which is what makes the chat's password rule apply.
    expect(setUpConnectorNamesOf([{ name: 'Calendar', manifest: { url: row.manifest.url } }])).toEqual(['Calendar']);
    // The origin is trusted, so the read-only calendar tools run without a card.
    const origins = firstPartyOriginsFor({ raw: undefined, calendarUrl: configuration.CALENDAR_SIDECAR_MCP_URL });
    expect(isFirstPartyOrigin({ url: row.manifest.url, origins })).toBe(true);
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
