import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import type {
  DeleteMcpServerInput,
  IMcpServerStore,
  McpServerRecord,
  UpsertMcpServerInput,
} from '../../../src/db/mcpServerStore';
import { ConnectorAccountError } from '../../../src/runtime/connectorAccount';
import {
  getMailAccountState,
  MAIL_SIGN_IN_REFUSED_MESSAGE,
  registerMailConnectorFromSavedAccountInBackground,
  removeMailAccount,
  resolveMailAccountSave,
  saveMailAccount,
  setMailDefaultAccount,
  syncMailConnectorWithAccount,
  type MailAccountState,
} from '../../../src/runtime/mailAccount';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const ACCOUNT_URL = 'http://mail-email:9559';
const SECRET = 'test-account-secret-0123456789abcdef0123';

/** The list body the account agent answers with for one connected Gmail account. */
const AGENT_CONNECTED = {
  connected: true,
  accounts: [
    {
      sign_in: 'ok',
      address: 'person@gmail.com',
      imap_host: 'imap.gmail.com',
      imap_port: 993,
      imap_mode: 'ssl',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      smtp_mode: 'ssl',
    },
  ],
  default: 'person@gmail.com',
};

/** The flat body an agent that has not learned the list answer yet gives for one connected Gmail account. */
const AGENT_FLAT_CONNECTED = {
  connected: true,
  sign_in: 'ok',
  address: 'person@gmail.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_mode: 'ssl',
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  smtp_mode: 'ssl',
};

const PERSON_ACCOUNT: MailAccountState['account'] = {
  address: 'person@gmail.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_mode: 'ssl',
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  smtp_mode: 'ssl',
};

const CONNECTED_STATE: MailAccountState = {
  connected: true,
  sign_in: 'ok',
  account: PERSON_ACCOUNT,
  accounts: [{ account: PERSON_ACCOUNT, sign_in: 'ok' }],
  default_key: 'person@gmail.com',
};

const NOT_CONNECTED_STATE: MailAccountState = {
  connected: false,
  sign_in: null,
  account: null,
  accounts: [],
  default_key: null,
};

describe('resolving a save from the Settings form', () => {
  it('fills the servers from the picked provider', () => {
    const resolved = resolveMailAccountSave({
      provider_key: 'gmail',
      address: 'person@gmail.com',
      password: CANARY,
      imap_host: undefined,
      imap_port: undefined,
      smtp_host: undefined,
      smtp_port: undefined,
    });
    expect(resolved).toEqual({
      ok: true,
      payload: {
        provider_key: 'gmail',
        address: 'person@gmail.com',
        password: CANARY,
        imap_host: 'imap.gmail.com',
        imap_port: 993,
        imap_mode: 'ssl',
        smtp_host: 'smtp.gmail.com',
        smtp_port: 465,
        smtp_mode: 'ssl',
      },
    });
  });

  it('takes the modes from the ports for a typed provider', () => {
    const resolved = resolveMailAccountSave({
      provider_key: 'other',
      address: 'person@example.com',
      password: CANARY,
      imap_host: 'imap.example.com',
      imap_port: 993,
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.payload['imap_mode']).toBe('ssl');
      expect(resolved.payload['smtp_mode']).toBe('starttls');
    }
  });

  it('asks for the missing pieces in plain words', () => {
    const resolved = resolveMailAccountSave({
      provider_key: 'other',
      address: 'person@example.com',
      password: CANARY,
      imap_host: 'imap.example.com',
      imap_port: undefined,
      smtp_host: undefined,
      smtp_port: undefined,
    });
    expect(resolved).toEqual({ ok: false, message: 'Enter both server names and both ports, then try again.' });
  });

  it('cleans the display spaces out of a Gmail password before it is checked or saved', () => {
    const resolved = resolveMailAccountSave({
      provider_key: 'gmail',
      address: 'person@gmail.com',
      password: 'CANARY APP PASSWORD 7f3d9',
      imap_host: undefined,
      imap_port: undefined,
      smtp_host: undefined,
      smtp_port: undefined,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.payload['password']).toBe('CANARYAPPPASSWORD7f3d9');
    }
  });
});

describe('the account agent client', () => {
  const logger = createLogger({ silent: true });

  it('reads a status the agent reports', async () => {
    const fetchImpl = async () => new Response(JSON.stringify(AGENT_CONNECTED), { status: 200 });
    await expect(getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger })).resolves.toEqual(CONNECTED_STATE);
  });

  it('reads a not-connected status', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ connected: false }), { status: 200 });
    await expect(getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger })).resolves.toEqual(
      NOT_CONNECTED_STATE,
    );
  });

  it('reads a status from an agent that still answers with one flat account', async () => {
    const fetchImpl = async () => new Response(JSON.stringify(AGENT_FLAT_CONNECTED), { status: 200 });
    await expect(getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger })).resolves.toEqual(CONNECTED_STATE);
  });

  it('reads a refused sign-in from an agent that still answers with one flat account', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ ...AGENT_FLAT_CONNECTED, sign_in: 'refused' }), { status: 200 });
    const state = await getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger });
    expect(state.connected).toBe(true);
    expect(state.sign_in).toBe('refused');
    expect(state.account).toEqual(PERSON_ACCOUNT);
  });

  it('a reply that is not the status shape is a plain connector failure, never echoed', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ connected: true, debug: CANARY }), { status: 200 });
    const failure = await getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger }).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(ConnectorAccountError);
    expect(failure instanceof Error ? failure.message : '').not.toContain(CANARY);
  });

  it('maps the agent refusal codes onto the plain lines', async () => {
    const refused = async () => new Response(JSON.stringify({ error: 'sign_in_refused' }), { status: 400 });
    const failure = await saveMailAccount(
      { accountUrl: ACCOUNT_URL, fetchImpl: refused, logger },
      {
        provider_key: 'gmail',
        address: 'person@gmail.com',
        password: CANARY,
        imap_host: undefined,
        imap_port: undefined,
        smtp_host: undefined,
        smtp_port: undefined,
      },
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ConnectorAccountError);
    expect(failure instanceof ConnectorAccountError ? failure.failure : '').toBe('sign_in_refused');
    expect(failure instanceof Error ? failure.message : '').toBe(MAIL_SIGN_IN_REFUSED_MESSAGE);
  });

  it('a down agent is a connector failure, and its words never leak', async () => {
    const down = async (): Promise<Response> => {
      throw new Error(`connect failed while using ${CANARY}`);
    };
    const failure = await saveMailAccount(
      { accountUrl: ACCOUNT_URL, fetchImpl: down, logger },
      {
        provider_key: 'gmail',
        address: 'person@gmail.com',
        password: CANARY,
        imap_host: undefined,
        imap_port: undefined,
        smtp_host: undefined,
        smtp_port: undefined,
      },
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ConnectorAccountError);
    expect(failure instanceof Error ? failure.message : '').not.toContain(CANARY);
  });

  it('with no account address configured, the client fails as not offered', async () => {
    const failure = await getMailAccountState({ accountUrl: undefined, fetchImpl: undefined, logger }).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(ConnectorAccountError);
  });

  it('reads two accounts and takes the view from the named default', async () => {
    const second = {
      sign_in: 'refused',
      address: 'second@example.com',
      imap_host: 'imap.example.com',
      imap_port: 993,
      imap_mode: 'ssl',
      smtp_host: 'smtp.example.com',
      smtp_port: 465,
      smtp_mode: 'ssl',
    };
    const body = {
      connected: true,
      accounts: [AGENT_CONNECTED.accounts[0], second],
      default: 'second@example.com',
    };
    const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
    const state = await getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger });
    expect(state.accounts.map(entry => entry.account.address)).toEqual(['person@gmail.com', 'second@example.com']);
    expect(state.default_key).toBe('second@example.com');
    expect(state.account?.address).toBe('second@example.com');
    expect(state.sign_in).toBe('refused');
  });

  it('removing one account names it, and removing every account names none', async () => {
    const seen: Array<{ method: string; body: unknown }> = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? '',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ connected: false }), { status: 200 });
    };
    const deps = { accountUrl: ACCOUNT_URL, fetchImpl, logger };
    await removeMailAccount(deps, 'person@gmail.com');
    await removeMailAccount(deps);
    expect(seen).toEqual([
      { method: 'DELETE', body: { address: 'person@gmail.com' } },
      { method: 'DELETE', body: {} },
    ]);
  });

  it('setting the default posts the address to the default route', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (input: unknown, init?: RequestInit) => {
      seen.push({
        url: typeof input === 'string' ? input : '',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(AGENT_CONNECTED), { status: 200 });
    };
    const state = await setMailDefaultAccount({ accountUrl: ACCOUNT_URL, fetchImpl, logger }, 'person@gmail.com');
    expect(seen).toEqual([{ url: `${ACCOUNT_URL}/account/default`, body: { address: 'person@gmail.com' } }]);
    expect(state.default_key).toBe('person@gmail.com');
  });

  it('setting the default to an account that is not saved is a plain refusal', async () => {
    const refused = async () => new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
    const failure = await setMailDefaultAccount(
      { accountUrl: ACCOUNT_URL, fetchImpl: refused, logger },
      'ghost@example.com',
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ConnectorAccountError);
    expect(failure instanceof ConnectorAccountError ? failure.failure : '').toBe('invalid_request');
  });
});

describe('keeping the connector registration in step', () => {
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

  it('registers once, updates in place, and unregisters on remove', async () => {
    const fake = makeFakeStore();
    const policyPath = join(mkdtempSync(join(tmpdir(), 'mail-policy-')), 'allowed_recipients.toml');
    const deps = {
      // An instantly refused address, so the send-list first fill inside the sync fails fast.
      mcpUrl: 'http://127.0.0.1:1/mcp',
      policyPath,
      mcpServerStore: fake.store,
      tenant_id: 't1',
      logger: createLogger({ silent: true }),
    };
    await syncMailConnectorWithAccount({ ...deps, state: CONNECTED_STATE });
    await syncMailConnectorWithAccount({ ...deps, state: CONNECTED_STATE });
    expect(fake.rows.size).toBe(1);
    const row = [...fake.rows.values()][0];
    expect(row?.name).toBe('Email');
    expect(row?.manifest).toMatchObject({ type: 'remote', url: 'http://127.0.0.1:1/mcp' });
    await syncMailConnectorWithAccount({ ...deps, state: NOT_CONNECTED_STATE });
    expect(fake.rows.size).toBe(0);
  });

  describe('at boot, on an instance the installer never linked', () => {
    const logger = createLogger({ silent: true });
    const sleep = (): Promise<void> => Promise.resolve();
    const settled = async (done: () => boolean): Promise<void> => {
      for (let tries = 0; tries < 200 && !done(); tries += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    const boot = (fetchImpl: typeof fetch, store: ReturnType<typeof makeFakeStore>['store']) =>
      registerMailConnectorFromSavedAccountInBackground({
        accountUrl: ACCOUNT_URL,
        secret: SECRET,
        mcpUrl: 'http://127.0.0.1:1/mcp',
        policyPath: undefined,
        fetchImpl,
        mcpServerStore: store,
        tenant_id: 't1',
        logger,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, attempts: 5 },
        sleep,
      });

    it('registers Email for a saved account whose login is refused, and drops it only when none is saved', async () => {
      const fake = makeFakeStore();
      boot(
        async () => new Response(JSON.stringify({ ...AGENT_CONNECTED, sign_in: 'refused' }), { status: 200 }),
        fake.store,
      );
      await settled(() => fake.rows.size === 1);
      expect(fake.rows.size).toBe(1);
      boot(async () => new Response(JSON.stringify({ connected: false }), { status: 200 }), fake.store);
      await settled(() => fake.rows.size === 0);
      expect(fake.rows.size).toBe(0);
    });

    it('keeps asking while the mail agent is still starting, then registers', async () => {
      const fake = makeFakeStore();
      let calls = 0;
      boot(async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('connection refused');
        }
        return new Response(JSON.stringify(AGENT_CONNECTED), { status: 200 });
      }, fake.store);
      await settled(() => fake.rows.size === 1);
      expect(calls).toBe(3);
      expect(fake.rows.size).toBe(1);
    });

    it('with an agent address but no secret, registers nothing and says why in one line', async () => {
      const fake = makeFakeStore();
      const warnLogger = createLogger({ silent: true });
      const warn = jest.spyOn(warnLogger, 'warn');
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify(AGENT_CONNECTED), { status: 200 }));
      registerMailConnectorFromSavedAccountInBackground({
        accountUrl: ACCOUNT_URL,
        secret: undefined,
        mcpUrl: 'http://127.0.0.1:1/mcp',
        policyPath: undefined,
        fetchImpl,
        mcpServerStore: fake.store,
        tenant_id: 't1',
        logger: warnLogger,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, attempts: 5 },
        sleep,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(fake.rows.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAIL_EMAIL_ACCOUNT_SECRET'));
    });

    it('presents the secret to the agent when it asks at boot', async () => {
      const fake = makeFakeStore();
      const authorizations: (string | null)[] = [];
      boot(async (_input: string | Request | URL, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify(AGENT_CONNECTED), { status: 200 });
      }, fake.store);
      await settled(() => fake.rows.size === 1);
      expect(fake.rows.size).toBe(1);
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every(value => value === `Bearer ${SECRET}`)).toBe(true);
    });
  });
});
