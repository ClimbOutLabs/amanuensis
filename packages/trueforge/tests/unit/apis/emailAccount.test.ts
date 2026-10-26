import { MICROSOFT_MAIL_MESSAGE } from '@truefoundry/trueforge-core/core/email/mailConnector/presets';
import { Hono } from 'hono';
import { createLogger } from 'winston';
import { EMAIL_SETTINGS_BASE_PATH, createEmailAccountRouter } from '../../../src/apis/emailAccount';
import configuration from '../../../src/config';
import type {
  DeleteMcpServerInput,
  IMcpServerStore,
  McpServerRecord,
  UpsertMcpServerInput,
} from '../../../src/db/mcpServerStore';
import {
  MAIL_CONNECTOR_UNREACHABLE_MESSAGE,
  MAIL_SERVER_UNREACHABLE_MESSAGE,
  MAIL_SIGN_IN_REFUSED_MESSAGE,
  MAIL_STATUS_UNREACHABLE_MESSAGE,
} from '../../../src/runtime/mailAccount';

const BASE = EMAIL_SETTINGS_BASE_PATH;
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const ACCOUNT_URL = 'http://mail-email:9559';

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

const NOT_CONNECTED: AgentBody = { connected: false, sign_in: null };

/** A connected agent body for a custom account, carrying the canary where a leak would show. */
const CONNECTED: AgentBody = {
  connected: true,
  address: 'person@example.com',
  imap_host: 'imap.example.com',
  imap_port: 993,
  imap_mode: 'ssl',
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_mode: 'starttls',
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

describe('the email settings endpoints', () => {
  const originalAccountUrl = configuration.MAIL_EMAIL_ACCOUNT_URL;
  const originalMcpUrl = configuration.MAIL_SIDECAR_MCP_URL;
  let agent: ReturnType<typeof makeFakeAgent>;
  let fakeStore: ReturnType<typeof makeFakeStore>;
  let app: Hono;

  beforeEach(() => {
    agent = makeFakeAgent();
    fakeStore = makeFakeStore();
    configuration.MAIL_EMAIL_ACCOUNT_URL = ACCOUNT_URL;
    // An instantly refused address: the registration sync also tries a first send-list fill
    // against it, and a real sidecar name would hang the test on DNS and retries.
    configuration.MAIL_SIDECAR_MCP_URL = 'http://127.0.0.1:1/mcp';
    const router = createEmailAccountRouter({
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
    configuration.MAIL_EMAIL_ACCOUNT_URL = originalAccountUrl;
    configuration.MAIL_SIDECAR_MCP_URL = originalMcpUrl;
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

  it('reports Not connected, with the provider list, when no account is saved', async () => {
    agent.script([{ status: 200, body: NOT_CONNECTED }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    const data = JSON.parse(text).data;
    expect(data.available).toBe(true);
    expect(data.state).toBe('not_connected');
    expect(data.address).toBeNull();
    expect(data.providers.map((provider: { key: string }) => provider.key)).toEqual([
      'gmail',
      'yahoo',
      'aol',
      'icloud',
      'fastmail',
      'zoho',
      'gmx',
      'webde',
    ]);
    expect(data.providers[0].help_url).toBe('https://support.google.com/accounts/answer/185833');
  });

  it('reports Connected with the address, and never the password', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, password: CANARY } }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY);
    const data = JSON.parse(text).data;
    expect(data.state).toBe('connected');
    expect(data.address).toBe('person@example.com');
    expect(data.provider_key).toBe('other');
  });

  it('reports a stopped sign-in in plain words', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, sign_in: 'refused' } }]);
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.state).toBe('sign_in_stopped');
  });

  it('hides the card when the instance has no email connector to configure', async () => {
    configuration.MAIL_EMAIL_ACCOUNT_URL = undefined;
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.available).toBe(false);
    expect(agent.calls).toHaveLength(0);
  });

  it('fails the status plainly when the connector cannot be reached', async () => {
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
    expect(text).not.toContain(CANARY);
  });

  it('fails the status plainly when the connector answers with an error', async () => {
    agent.script([{ status: 500, body: { error: 'boom' } }]);
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(MAIL_STATUS_UNREACHABLE_MESSAGE);
    expect(MAIL_STATUS_UNREACHABLE_MESSAGE).toBe("Couldn't check your email account just now. Try again.");
  });

  it('checks a Gmail sign-in before saving, and registers the connector', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, address: 'person@gmail.com' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmail', address: 'person@gmail.com', password: ' CANARY APP PASSWORD 7f3d9 ' },
    });
    expect(status).toBe(201);
    expect(JSON.parse(text).data.state).toBe('connected');
    // The agent was asked once, with the preset servers and the password with its display spaces removed.
    expect(agent.calls).toHaveLength(1);
    const sent = JSON.parse(agent.calls[0]?.body ?? '{}');
    expect(sent.imap_host).toBe('imap.gmail.com');
    expect(sent.smtp_host).toBe('smtp.gmail.com');
    expect(sent.password).toBe('CANARYAPPPASSWORD7f3d9');
    // The connector registration now points at the sidecar.
    const registered = [...fakeStore.rows.values()];
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('Email');
    expect(registered[0]?.manifest).toMatchObject({ type: 'remote', url: 'http://127.0.0.1:1/mcp' });
  });

  it('a refused sign-in shows the refused line and saves nothing', async () => {
    agent.script([{ status: 400, body: { error: 'sign_in_refused' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'zoho', address: 'person@zoho.com', password: CANARY },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe(MAIL_SIGN_IN_REFUSED_MESSAGE);
    expect(MAIL_SIGN_IN_REFUSED_MESSAGE).toBe('That password was refused. Make a new app password and try again.');
    expect(text).not.toContain(CANARY);
    // One check call only; no connector was registered and nothing was stored server-side.
    expect(agent.calls).toHaveLength(1);
    expect(fakeStore.rows.size).toBe(0);
  });

  it('an unreachable server shows the unreachable line', async () => {
    agent.script([{ status: 400, body: { error: 'server_unreachable' } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: {
        provider_key: 'other',
        address: 'person@example.com',
        password: CANARY,
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 465,
      },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe(MAIL_SERVER_UNREACHABLE_MESSAGE);
    expect(MAIL_SERVER_UNREACHABLE_MESSAGE).toBe("Couldn't reach that mail server. Check the server name and port.");
    expect(text).not.toContain(CANARY);
  });

  it('never repeats what the connector says back: a leaky error stays out of the response', async () => {
    agent.script([{ status: 500, body: { error: `boom while signing in with ${CANARY}` } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmail', address: 'person@gmail.com', password: CANARY },
    });
    expect(status).toBe(502);
    expect(JSON.parse(text).error.message).toBe(MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
    expect(text).not.toContain(CANARY);
  });

  it('a save answer that echoes the password is dropped by the status parser', async () => {
    agent.script([{ status: 200, body: { ...CONNECTED, password: CANARY, debug: CANARY } }]);
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: {
        provider_key: 'other',
        address: 'person@example.com',
        password: CANARY,
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 587,
      },
    });
    expect(status).toBe(201);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text).data.address).toBe('person@example.com');
  });

  it('refuses a bad address before the connector is asked', async () => {
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmail', address: 'not-an-address', password: CANARY },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe('That does not look like an email address. Check it and try again.');
    expect(agent.calls).toHaveLength(0);
  });

  it('refuses a Microsoft address with the coming-later line, like the installer', async () => {
    const { status, text } = await call({
      method: 'POST',
      path: '/',
      body: {
        provider_key: 'other',
        address: 'person@outlook.com',
        password: CANARY,
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 465,
      },
    });
    expect(status).toBe(400);
    expect(JSON.parse(text).error.message).toBe(MICROSOFT_MAIL_MESSAGE);
    expect(agent.calls).toHaveLength(0);
  });

  it('refuses a password the account file cannot hold', async () => {
    const { status } = await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmail', address: 'person@gmail.com', password: "has a ' quote" },
    });
    expect(status).toBe(400);
    expect(agent.calls).toHaveLength(0);
  });

  it('remove deletes the account and the connector registration', async () => {
    agent.script([
      { status: 200, body: { ...CONNECTED, address: 'person@gmail.com' } },
      { status: 200, body: NOT_CONNECTED },
    ]);
    await call({
      method: 'POST',
      path: '/',
      body: { provider_key: 'gmail', address: 'person@gmail.com', password: CANARY },
    });
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
      body: `provider_key=gmail&address=person@gmail.com&password=${CANARY}`,
      contentType: 'application/x-www-form-urlencoded',
      origin: 'https://evil.example.net',
    });
    expect(status).toBe(403);
    expect(JSON.parse(text).error.message).toBe('That request did not come from Aman, so nothing was done.');
    expect(agent.calls).toHaveLength(0);
  });

  it('refuses a bodiless remove from another site', async () => {
    const { status } = await call({ method: 'DELETE', path: '/', origin: 'https://evil.example.net' });
    expect(status).toBe(403);
    expect(agent.calls).toHaveLength(0);
  });
});
