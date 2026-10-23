import {
  parseMailAccountEnv,
  renderMailAccountEnv,
  type MailAccount,
} from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const AGENT = resolve(REPO_ROOT, 'ops/compose/mail-email/account_agent.py');
const EMAIL_CHECK = resolve(REPO_ROOT, 'ops/compose/mail-email/email_check.py');
const FAKE_IMAP = resolve(REPO_ROOT, 'installer/tests/fake_imap.py');

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const WRONG = 'CANARY-WRONG-PASSWORD-9z';
const AGENT_PORT = 19771;
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

  async function agentCall(method: string, body?: unknown): Promise<{ status: number; text: string }> {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${String(AGENT_PORT)}/account`, init);
    return { status: response.status, text: await response.text() };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-agent-'));
    accountFile = join(dir, '.env.mail-email');
    writeFileSync(accountFile, '', { mode: 0o600 });
    // A self-signed certificate for localhost, trusted by the check through SSL_CERT_FILE.
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
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
        AMAN_MAIL_ACCOUNT_PORT: String(AGENT_PORT),
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
    expect(JSON.parse(text).connected).toBe(false);
    expect(text).not.toContain(CANARY);
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

  it('saves a checked account in the installer file format, mode 600, and never returns the password', async () => {
    const { status, text } = await agentCall('POST', postBody(CANARY));
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY);
    const body = JSON.parse(text);
    expect(body.connected).toBe(true);
    expect(body.address).toBe(ADDRESS);
    expect(body.sign_in).toBe('ok');
    expect(readFileSync(accountFile, 'utf8')).toBe(renderMailAccountEnv(accountWith(CANARY)));
    expect(statSync(accountFile).mode & 0o777).toBe(0o600);
    // The fake server recorded the exact password the check signed in with: the password
    // that was checked is the password that was saved.
    expect(readFileSync(join(dir, 'imap.port.login'), 'utf8').trim()).toBe(CANARY);
  }, 30_000);

  it('reports a saved sign-in that stopped working after the file changes under it', async () => {
    writeFileSync(accountFile, renderMailAccountEnv(accountWith(WRONG)), { mode: 0o600 });
    const { text } = await agentCall('GET');
    const body = JSON.parse(text);
    expect(body.connected).toBe(true);
    expect(body.sign_in).toBe('refused');
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

  it('the agent never printed the password anywhere', () => {
    expect(agentOutput).not.toContain(CANARY);
    expect(agentOutput).not.toContain(WRONG);
  });

  it('the child env comes from the account file, and clears when the account goes', async () => {
    await agentCall('POST', postBody(CANARY));
    const withAccount = execFileSync('python3', [AGENT, '--print-child-env'], {
      env: { ...process.env, AMAN_MAIL_ACCOUNT_FILE: accountFile },
      encoding: 'utf8',
    });
    expect(withAccount).toContain(`MCP_EMAIL_SERVER_EMAIL_ADDRESS=${ADDRESS}`);
    expect(withAccount).toContain('MCP_EMAIL_SERVER_IMAP_SSL=true');
    await agentCall('DELETE');
    const without = execFileSync('python3', [AGENT, '--print-child-env'], {
      env: { ...process.env, AMAN_MAIL_ACCOUNT_FILE: accountFile },
      encoding: 'utf8',
    });
    expect(without).not.toContain('MCP_EMAIL_SERVER_EMAIL_ADDRESS=');
    expect(without).toContain('unset MCP_EMAIL_SERVER_EMAIL_ADDRESS MCP_EMAIL_SERVER_PASSWORD');
  }, 30_000);
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
