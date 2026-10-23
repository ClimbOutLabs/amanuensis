import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import {
  getMailAccountState,
  MAIL_SIGN_IN_REFUSED_MESSAGE,
  MailAccountError,
  resolveMailAccountSave,
  saveMailAccount,
  syncMailConnectorWithAccount,
  type MailAccountState,
} from '../../../src/runtime/mailAccount';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const ACCOUNT_URL = 'http://mail-email:9559';

/** The flat body the account agent answers with for a connected Gmail account. */
const AGENT_CONNECTED = {
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

const CONNECTED_STATE: MailAccountState = {
  connected: true,
  sign_in: 'ok',
  account: {
    address: 'person@gmail.com',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
  },
};

const NOT_CONNECTED_STATE: MailAccountState = { connected: false, sign_in: null, account: null };

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
      expect(resolved.payload.imap_mode).toBe('ssl');
      expect(resolved.payload.smtp_mode).toBe('starttls');
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
      expect(resolved.payload.password).toBe('CANARYAPPPASSWORD7f3d9');
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

  it('a reply that is not the status shape is a plain connector failure, never echoed', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ connected: true, debug: CANARY }), { status: 200 });
    const failure = await getMailAccountState({ accountUrl: ACCOUNT_URL, fetchImpl, logger }).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(MailAccountError);
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
    expect(failure).toBeInstanceOf(MailAccountError);
    expect(failure instanceof MailAccountError ? failure.failure : '').toBe('sign_in_refused');
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
    expect(failure).toBeInstanceOf(MailAccountError);
    expect(failure instanceof Error ? failure.message : '').not.toContain(CANARY);
  });

  it('with no account address configured, the client fails as not offered', async () => {
    const failure = await getMailAccountState({ accountUrl: undefined, fetchImpl: undefined, logger }).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(MailAccountError);
  });
});

describe('keeping the connector registration in step', () => {
  function makeFakeStore() {
    const rows = new Map<
      string,
      { tenant_id: string; name: string; manifest: { url?: string }; first_party: boolean }
    >();
    return {
      rows,
      store: {
        upsertServer: async (row: {
          tenant_id: string;
          name: string;
          manifest: { url?: string };
          first_party: boolean;
        }) => {
          rows.set(`${row.tenant_id}:${row.name}`, row);
        },
        deleteServer: async (input: { tenant_id: string; name: string }) => {
          rows.delete(`${input.tenant_id}:${input.name}`);
        },
      },
    };
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
    expect(row?.manifest.url).toBe('http://127.0.0.1:1/mcp');
    await syncMailConnectorWithAccount({ ...deps, state: NOT_CONNECTED_STATE });
    expect(fake.rows.size).toBe(0);
  });
});
