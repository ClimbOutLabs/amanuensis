import {
  parseMailAccountEnv,
  parseMailAccountsEnv,
  renderMailAccountEnv,
  renderMailAccountsEnv,
  type MailAccount,
} from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { connectorKeyId } from '../../../src/runtime/connectorAccountKey';
import { giveMailAgentKey, MAIL_AGENT_KEY, openMailAccountText, sealMailAccountText } from './mailAgentSupport';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const AGENT = resolve(REPO_ROOT, 'ops/compose/mail-email/account_agent.py');
const EMAIL_CHECK = resolve(REPO_ROOT, 'ops/compose/mail-email/email_check.py');
const FAKE_IMAP = resolve(REPO_ROOT, 'installer/tests/fake_imap.py');

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const WRONG = 'CANARY-WRONG-PASSWORD-9z';
const SECRET = 'test-account-secret-0123456789abcdef0123';
const WRONG_SECRET = 'test-account-secret-ffffffffffffffffffff';
const AGENT_PORT = 19771;
const AGENT_URL = `http://127.0.0.1:${String(AGENT_PORT)}`;
const ADDRESS = 'person@example.com';

/** Waits until `check` passes, polling. Fails the test when it never does. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe('the mail account agent', () => {
  let dir: string;
  let accountFile: string;
  let imapPort: number;
  let imap: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  let agentOutput = '';
  let certPath = '';
  let keyPath = '';

  function accountWith(password: string): MailAccount {
    return {
      address: ADDRESS,
      password,
      imap_host: 'localhost',
      imap_port: imapPort,
      imap_mode: 'ssl',
      smtp_host: 'localhost',
      smtp_port: 465,
      smtp_mode: 'ssl',
    };
  }

  /** The wire body the server sends the agent for an account: the account plus its provider key. */
  function postBody(password: string): Record<string, unknown> {
    return { provider_key: 'other', ...accountWith(password) };
  }

  async function rawAgentCall({
    method,
    authorization,
    body,
    path = '/account',
  }: {
    method: string;
    authorization: string | undefined;
    body?: unknown;
    path?: string;
  }): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization !== undefined) {
      headers['authorization'] = authorization;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${String(AGENT_PORT)}${path}`, init);
    return { status: response.status, text: await response.text() };
  }

  async function agentCall(method: string, body?: unknown): Promise<{ status: number; text: string }> {
    return rawAgentCall({ method, authorization: `Bearer ${SECRET}`, body });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-agent-'));
    accountFile = join(dir, '.env.mail-email');
    writeFileSync(accountFile, '', { mode: 0o600 });
    // A self-signed certificate for localhost, trusted by the check through SSL_CERT_FILE.
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    certPath = cert;
    keyPath = key;
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const portFile = join(dir, 'imap.port');
    imap = spawn('python3', [FAKE_IMAP, 'ssl', cert, key, ADDRESS, CANARY, portFile], { stdio: 'ignore' });
    await eventually(async () => existsSync(portFile) && readFileSync(portFile, 'utf8').trim() !== '');
    imapPort = Number(readFileSync(portFile, 'utf8').trim());
    agent = spawn('python3', [AGENT], {
      env: {
        ...process.env,
        AMAN_MAIL_ACCOUNT_FILE: accountFile,
        AMAN_MAIL_RUN_DIR: join(dir, 'run'),
        AMAN_MAIL_ACCOUNT_PORT: String(AGENT_PORT),
        AMAN_MAIL_ACCOUNT_SECRET: SECRET,
        AMAN_MAIL_EMAIL_CHECK: EMAIL_CHECK,
        SSL_CERT_FILE: cert,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout?.on('data', (chunk: Buffer) => {
      agentOutput += chunk.toString();
    });
    agent.stderr?.on('data', (chunk: Buffer) => {
      agentOutput += chunk.toString();
    });
    await eventually(async () => {
      try {
        const reply = await agentCall('GET');
        return reply.status === 200;
      } catch {
        return false;
      }
    });
  }, 60_000);

  afterAll(() => {
    agent?.kill('SIGKILL');
    imap?.kill('SIGKILL');
  });

  it('starts with no account connected', async () => {
    const { status, text } = await agentCall('GET');
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.connected).toBe(false);
    expect(body.accounts).toEqual([]);
    expect(body.default).toBeNull();
    expect(text).not.toContain(CANARY);
  });

  it('refuses a caller that presents no secret, and changes nothing for it', async () => {
    for (const method of ['GET', 'DELETE']) {
      const { status, text } = await rawAgentCall({ method, authorization: undefined });
      expect(status).toBe(401);
      expect(JSON.parse(text).error).toBe('unauthorized');
    }
    const { status, text } = await rawAgentCall({ method: 'POST', authorization: undefined, body: postBody(CANARY) });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('unauthorized');
    const after = await agentCall('GET');
    expect(JSON.parse(after.text).connected).toBe(false);
    expect(readFileSync(accountFile, 'utf8')).toBe('');
  });

  it('refuses a caller that presents the wrong secret', async () => {
    const { status, text } = await rawAgentCall({ method: 'GET', authorization: `Bearer ${WRONG_SECRET}` });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('unauthorized');
    expect(text).not.toContain(WRONG_SECRET);
  });

  it('refuses a caller whose secret does not arrive as a bearer value', async () => {
    const { status, text } = await rawAgentCall({ method: 'GET', authorization: SECRET });
    expect(status).toBe(401);
    expect(JSON.parse(text).error).toBe('unauthorized');
  });

  it('saves nothing while it holds no key for its account file', async () => {
    const held = await rawAgentCall({ method: 'GET', authorization: `Bearer ${SECRET}`, path: '/key' });
    expect(JSON.parse(held.text)).toEqual({ key_id: null });
    const { status, text } = await agentCall('POST', postBody(CANARY));
    expect(status).toBe(423);
    expect(JSON.parse(text).error).toBe('locked');
    expect(readFileSync(accountFile, 'utf8')).toBe('');
  }, 30_000);

  it('takes a key only from a caller with the secret, and only a whole key', async () => {
    const stranger = await rawAgentCall({
      method: 'POST',
      authorization: undefined,
      path: '/key',
      body: { current: MAIL_AGENT_KEY, earlier: [] },
    });
    expect(stranger.status).toBe(401);
    const short = await giveMailAgentKey({ url: AGENT_URL, secret: SECRET, key: 'abcd' });
    expect(short.status).toBe(400);
    const given = await giveMailAgentKey({ url: AGENT_URL, secret: SECRET });
    expect(given.status).toBe(200);
    const held = await rawAgentCall({ method: 'GET', authorization: `Bearer ${SECRET}`, path: '/key' });
    expect(held.text).not.toContain(MAIL_AGENT_KEY);
    expect(JSON.parse(held.text)).toEqual(given.body);
    // The same short name the app works out, so the app can tell the key is held without sending it.
    expect(given.body).toEqual({ key_id: connectorKeyId(Buffer.from(MAIL_AGENT_KEY, 'hex')) });
  });

  it('checks before saving: a refused sign-in saves nothing', async () => {
    const before = readFileSync(accountFile, 'utf8');
    const { status, text } = await agentCall('POST', postBody(WRONG));
    expect(status).toBe(400);
    expect(JSON.parse(text).error).toBe('sign_in_refused');
    expect(text).not.toContain(WRONG);
    expect(readFileSync(accountFile, 'utf8')).toBe(before);
  }, 30_000);

  it('an unreachable server saves nothing either', async () => {
    const before = readFileSync(accountFile, 'utf8');
    const unreachable = { ...postBody(CANARY), imap_port: 59998 };
    const { status, text } = await agentCall('POST', unreachable);
    expect(status).toBe(400);
    expect(JSON.parse(text).error).toBe('server_unreachable');
    expect(readFileSync(accountFile, 'utf8')).toBe(before);
  }, 30_000);

  it('saves a checked account encrypted, in the installer file format, mode 600, and never returns the password', async () => {
    const { status, text } = await agentCall('POST', postBody(CANARY));
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY);
    const body = JSON.parse(text);
    expect(body.connected).toBe(true);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].address).toBe(ADDRESS);
    expect(body.accounts[0].sign_in).toBe('ok');
    expect(body.default).toBe(ADDRESS);
    const onDisk = readFileSync(accountFile, 'utf8');
    // Nothing of the account is readable in the file: not the password, not even the address.
    expect(onDisk).not.toContain(CANARY);
    expect(onDisk).not.toContain(ADDRESS);
    expect(openMailAccountText({ sealed: onDisk })).toBe(renderMailAccountEnv(accountWith(CANARY)));
    expect(() => openMailAccountText({ sealed: onDisk, key: 'ff'.repeat(32) })).toThrow();
    expect(statSync(accountFile).mode & 0o777).toBe(0o600);
    // The fake server recorded the exact password the check signed in with: the password
    // that was checked is the password that was saved.
    expect(readFileSync(join(dir, 'imap.port.login'), 'utf8').trim()).toBe(CANARY);
  }, 30_000);

  it('reports a saved sign-in that stopped working after the file changes under it', async () => {
    writeFileSync(accountFile, sealMailAccountText({ text: renderMailAccountEnv(accountWith(WRONG)) }), {
      mode: 0o600,
    });
    const { text } = await agentCall('GET');
    const body = JSON.parse(text);
    expect(body.connected).toBe(true);
    expect(body.accounts[0].sign_in).toBe('refused');
    expect(text).not.toContain(WRONG);
  }, 30_000);

  it('remove empties the file and the status returns to not connected', async () => {
    await agentCall('POST', postBody(CANARY));
    expect(readFileSync(accountFile, 'utf8')).not.toBe('');
    const { status, text } = await agentCall('DELETE');
    expect(status).toBe(200);
    expect(JSON.parse(text).connected).toBe(false);
    expect(readFileSync(accountFile, 'utf8')).toBe('');
    expect(parseMailAccountEnv(readFileSync(accountFile, 'utf8'))).toBeNull();
    const after = await agentCall('GET');
    expect(JSON.parse(after.text).connected).toBe(false);
  }, 30_000);

  it('refuses a request under a foreign host name', async () => {
    // fetch will not send a foreign Host header, so this goes through node:http directly.
    const status = await new Promise<number>((resolvePromise, rejectPromise) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: AGENT_PORT, path: '/account', method: 'GET', headers: { host: 'evil.example.net' } },
        response => {
          response.resume();
          resolvePromise(response.statusCode ?? 0);
        },
      );
      request.on('error', rejectPromise);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('holds several accounts: a second save adds, the default can move, and remove takes one', async () => {
    const secondAddress = 'work@example.com';
    const secondPortFile = join(dir, 'imap2.port');
    const secondImap = spawn('python3', [FAKE_IMAP, 'ssl', certPath, keyPath, secondAddress, CANARY, secondPortFile], {
      stdio: 'ignore',
    });
    try {
      await eventually(async () => existsSync(secondPortFile) && readFileSync(secondPortFile, 'utf8').trim() !== '');
      const secondPort = Number(readFileSync(secondPortFile, 'utf8').trim());
      const second: MailAccount = {
        address: secondAddress,
        password: CANARY,
        imap_host: 'localhost',
        imap_port: secondPort,
        imap_mode: 'ssl',
        smtp_host: 'localhost',
        smtp_port: 465,
        smtp_mode: 'ssl',
      };
      await agentCall('POST', postBody(CANARY));
      const added = await agentCall('POST', { provider_key: 'other', ...second });
      expect(added.status).toBe(200);
      const both = JSON.parse(added.text);
      expect(both.accounts.map((entry: { address: string }) => entry.address)).toEqual([ADDRESS, secondAddress]);
      expect(both.default).toBe(ADDRESS);
      expect(
        parseMailAccountsEnv(openMailAccountText({ sealed: readFileSync(accountFile, 'utf8') })).accounts,
      ).toHaveLength(2);

      const moved = await rawAgentCall({
        method: 'POST',
        authorization: `Bearer ${SECRET}`,
        body: { address: secondAddress },
        path: '/account/default',
      });
      expect(moved.status).toBe(200);
      expect(JSON.parse(moved.text).default).toBe(secondAddress);
      expect(
        parseMailAccountsEnv(openMailAccountText({ sealed: readFileSync(accountFile, 'utf8') })).default_address,
      ).toBe(secondAddress);

      const unknown = await rawAgentCall({
        method: 'POST',
        authorization: `Bearer ${SECRET}`,
        body: { address: 'nobody@example.com' },
        path: '/account/default',
      });
      expect(unknown.status).toBe(400);
      expect(JSON.parse(unknown.text).error).toBe('invalid');

      const removed = await agentCall('DELETE', { address: ADDRESS });
      expect(removed.status).toBe(200);
      const left = JSON.parse(removed.text);
      expect(left.accounts.map((entry: { address: string }) => entry.address)).toEqual([secondAddress]);
      expect(left.default).toBe(secondAddress);
      expect(openMailAccountText({ sealed: readFileSync(accountFile, 'utf8') })).toBe(
        renderMailAccountsEnv({ accounts: [second], default_address: secondAddress }),
      );
    } finally {
      secondImap.kill('SIGKILL');
      await agentCall('DELETE');
    }
  }, 60_000);

  it('the server config is rendered in the run folder, and clears when the account goes', async () => {
    const rendered = join(dir, 'run', 'accounts.toml');
    await agentCall('POST', postBody(CANARY));
    const withAccount = readFileSync(rendered, 'utf8');
    expect(withAccount).toContain('[[emails]]');
    expect(withAccount).toContain(`account_name = "${ADDRESS}"`);
    expect(withAccount).toContain(`email_address = "${ADDRESS}"`);
    expect(statSync(rendered).mode & 0o777).toBe(0o600);
    await agentCall('DELETE');
    expect(readFileSync(rendered, 'utf8')).toBe('');
  }, 30_000);

  it('the agent never printed the password or the secret anywhere', () => {
    expect(agentOutput).not.toContain(CANARY);
    expect(agentOutput).not.toContain(WRONG);
    expect(agentOutput).not.toContain(SECRET);
    expect(agentOutput).not.toContain(WRONG_SECRET);
  });
});

describe('the mail account agent with no usable secret', () => {
  let dir: string;
  let accountFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mail-agent-closed-'));
    accountFile = join(dir, '.env.mail-email');
    writeFileSync(accountFile, '', { mode: 0o600 });
  });

  function agentEnv(secretValue: string | undefined, port: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AMAN_MAIL_ACCOUNT_FILE: accountFile,
      AMAN_MAIL_RUN_DIR: join(dir, 'run'),
      AMAN_MAIL_ACCOUNT_PORT: String(port),
    };
    if (secretValue === undefined) {
      delete env['AMAN_MAIL_ACCOUNT_SECRET'];
    } else {
      env['AMAN_MAIL_ACCOUNT_SECRET'] = secretValue;
    }
    return env;
  }

  async function startAgent(
    secretValue: string | undefined,
    port: number,
  ): Promise<{ output: () => string; exited: Promise<number | null> }> {
    const child = spawn('python3', [AGENT], { env: agentEnv(secretValue, port), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>(resolvePromise => {
      child.on('close', code => {
        resolvePromise(code);
      });
    });
    return { output: () => output, exited };
  }

  it('does not serve, and says why, when no secret is set', async () => {
    const started = await startAgent(undefined, 19772);
    await expect(started.exited).resolves.toBe(0);
    expect(started.output()).toContain('no account secret is set, so its port is closed');
    await expect(fetch('http://127.0.0.1:19772/account')).rejects.toThrow();
  });

  it('does not serve when the secret is too short to use, and never prints it', async () => {
    const started = await startAgent('too-short', 19773);
    await expect(started.exited).resolves.toBe(0);
    expect(started.output()).toContain('no account secret is set, so its port is closed');
    expect(started.output()).not.toContain('too-short');
    await expect(fetch('http://127.0.0.1:19773/account')).rejects.toThrow();
  });
});

describe('the mail account file and its keys', () => {
  const OLD_KEY = '11'.repeat(32);
  const OTHER_KEY = '22'.repeat(32);
  const PORT = 19781;
  const URL_BASE = `http://127.0.0.1:${String(PORT)}`;
  const account: MailAccount = {
    address: ADDRESS,
    password: CANARY,
    imap_host: 'localhost',
    imap_port: 59997,
    imap_mode: 'ssl',
    smtp_host: 'localhost',
    smtp_port: 465,
    smtp_mode: 'ssl',
  };
  const accountText = renderMailAccountEnv(account);
  let dir: string;
  let accountFile: string;
  let agent: ChildProcess | undefined;

  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AMAN_MAIL_ACCOUNT_FILE: accountFile,
      AMAN_MAIL_RUN_DIR: join(dir, 'run'),
      AMAN_MAIL_ACCOUNT_PORT: String(PORT),
      AMAN_MAIL_ACCOUNT_SECRET: SECRET,
    };
  }

  async function startAgent(): Promise<void> {
    agent = spawn('python3', [AGENT], { env: env(), stdio: 'ignore' });
    await eventually(async () => {
      try {
        return (await fetch(`${URL_BASE}/key`, { headers: { authorization: `Bearer ${SECRET}` } })).status === 200;
      } catch {
        return false;
      }
    });
  }

  async function accountStatus(): Promise<number> {
    return (await fetch(`${URL_BASE}/account`, { headers: { authorization: `Bearer ${SECRET}` } })).status;
  }

  function rendered(): string {
    return readFileSync(join(dir, 'run', 'accounts.toml'), 'utf8');
  }

  function writeStdin(input: string): { status: number | null; stdout: string; stderr: string } {
    const done = spawnSync('python3', [AGENT, '--write-stdin'], { env: env(), input, encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mail-agent-keys-'));
    accountFile = join(dir, '.env.mail-email');
  });

  afterEach(() => {
    agent?.kill('SIGKILL');
    agent = undefined;
  });

  it('an encrypted file stays locked until its key arrives, and the server gets no account before that', async () => {
    writeFileSync(accountFile, sealMailAccountText({ text: accountText }), { mode: 0o600 });
    await startAgent();
    expect(await accountStatus()).toBe(423);
    expect(rendered()).toBe('');
    const wrong = await giveMailAgentKey({ url: URL_BASE, secret: SECRET, key: OTHER_KEY });
    expect(wrong).toEqual({ status: 409, body: { error: 'wrong_key' } });
    expect(await accountStatus()).toBe(423);
    expect((await giveMailAgentKey({ url: URL_BASE, secret: SECRET })).status).toBe(200);
    expect(rendered()).toContain(`email_address = "${ADDRESS}"`);
  }, 30_000);

  it('a file from before encryption is still read, and is encrypted once the key arrives', async () => {
    writeFileSync(accountFile, accountText, { mode: 0o600 });
    await startAgent();
    expect(rendered()).toContain(`email_address = "${ADDRESS}"`);
    expect((await giveMailAgentKey({ url: URL_BASE, secret: SECRET })).status).toBe(200);
    const onDisk = readFileSync(accountFile, 'utf8');
    expect(onDisk).not.toContain(CANARY);
    expect(openMailAccountText({ sealed: onDisk })).toBe(accountText);
    expect(statSync(accountFile).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('a file under an earlier key is opened with it and moved to the current key', async () => {
    writeFileSync(accountFile, sealMailAccountText({ text: accountText, key: OLD_KEY }), { mode: 0o600 });
    await startAgent();
    expect((await giveMailAgentKey({ url: URL_BASE, secret: SECRET, earlier: [OLD_KEY] })).status).toBe(200);
    expect(openMailAccountText({ sealed: readFileSync(accountFile, 'utf8') })).toBe(accountText);
    expect(rendered()).toContain(`email_address = "${ADDRESS}"`);
  }, 30_000);

  it('the installer write path encrypts with the key on its first line, and refuses to write without one', () => {
    const refused = writeStdin(accountText);
    expect(refused.status).toBe(2);
    expect(existsSync(accountFile)).toBe(false);
    const saved = writeStdin(`${MAIL_AGENT_KEY}\n${accountText}`);
    expect(saved).toEqual({ status: 0, stdout: 'saved\n', stderr: '' });
    const onDisk = readFileSync(accountFile, 'utf8');
    expect(onDisk).not.toContain(CANARY);
    expect(openMailAccountText({ sealed: onDisk })).toBe(accountText);
  });

  it('the installer write path keeps the other accounts, and leaves a file it cannot open alone', () => {
    const other: MailAccount = { ...account, address: 'nora@example.com' };
    writeFileSync(accountFile, sealMailAccountText({ text: renderMailAccountEnv(other), key: OLD_KEY }), {
      mode: 0o600,
    });
    const before = readFileSync(accountFile, 'utf8');
    const locked = writeStdin(`${MAIL_AGENT_KEY}\n${accountText}`);
    expect(locked.status).toBe(3);
    expect(locked.stderr).not.toContain(CANARY);
    expect(readFileSync(accountFile, 'utf8')).toBe(before);
    expect(writeStdin(`${MAIL_AGENT_KEY} ${OLD_KEY}\n${accountText}`).status).toBe(0);
    const merged = parseMailAccountsEnv(openMailAccountText({ sealed: readFileSync(accountFile, 'utf8') }));
    expect(merged.accounts.map(saved => saved.address)).toEqual(['nora@example.com', ADDRESS]);
  });

  it('the installer remove path empties the file with no key', () => {
    writeFileSync(accountFile, sealMailAccountText({ text: accountText }), { mode: 0o600 });
    const done = spawnSync('python3', [AGENT, '--remove'], { env: env(), encoding: 'utf8' });
    expect(done.stdout).toBe('removed\n');
    expect(readFileSync(accountFile, 'utf8')).toBe('');
  });
});

describe('the sign-in check is the installer check, byte for byte', () => {
  it('email_check.py equals EMAIL_CHECK_PY in installer/lib/email.sh', () => {
    const shell = readFileSync(resolve(REPO_ROOT, 'installer/lib/email.sh'), 'utf8');
    const start = shell.indexOf("cat <<'PY'\n");
    const end = shell.indexOf('\nPY\n', start);
    const fromShell = shell.slice(start + "cat <<'PY'\n".length, end + 1);
    expect(readFileSync(EMAIL_CHECK, 'utf8')).toBe(fromShell);
  });
});
