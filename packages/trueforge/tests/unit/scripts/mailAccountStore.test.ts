import {
  renderMailAccountEnv,
  type MailAccount,
} from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const AGENT = resolve(REPO_ROOT, 'ops/compose/mail-email/account_agent.py');
const EMAIL_CHECK = resolve(REPO_ROOT, 'ops/compose/mail-email/email_check.py');
const FAKE_IMAP = resolve(REPO_ROOT, 'installer/tests/fake_imap.py');
const EMAIL_SH = resolve(REPO_ROOT, 'installer/lib/email.sh');

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const AGENT_PORT = 19773;
const ADDRESS = 'person@example.com';

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** The installer's own email_env_text output for an account, from installer/lib/email.sh. */
function installerEnvText(account: MailAccount): string {
  const script = [
    'source "$1"',
    'EM_ADDRESS=$2 EM_PASSWORD=$3 EM_IMAP_HOST=$4 EM_IMAP_PORT=$5 EM_IMAP_MODE=$6 EM_SMTP_HOST=$7 EM_SMTP_PORT=$8 EM_SMTP_MODE=$9 email_env_text',
  ].join('\n');
  return execFileSync(
    'bash',
    [
      '-c',
      script,
      'test',
      EMAIL_SH,
      account.address,
      account.password,
      account.imap_host,
      String(account.imap_port),
      account.imap_mode,
      account.smtp_host,
      String(account.smtp_port),
      account.smtp_mode,
    ],
    { encoding: 'utf8' },
  );
}

/** One value out of the account file, the way the installer tests read it back. */
function fileValue(file: string, key: string): string {
  return execFileSync('bash', ['-c', `grep '^${key}=' "$1" | head -1 | cut -d= -f2-`, 'test', file], {
    encoding: 'utf8',
  }).trim();
}

describe('the installer and Settings share one account store', () => {
  let dir: string;
  let accountFile: string;
  let imapPort: number;
  let imap: ChildProcess | undefined;
  let agent: ChildProcess | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-store-'));
    accountFile = join(dir, '.env.mail-email');
    writeFileSync(accountFile, '', { mode: 0o600 });
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
      stdio: 'ignore',
    });
    await eventually(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(AGENT_PORT)}/account`);
        return response.status === 200;
      } catch {
        return false;
      }
    });
  }, 60_000);

  afterAll(() => {
    agent?.kill('SIGKILL');
    imap?.kill('SIGKILL');
  });

  it('an account the installer writes is the account the sidecar reports', async () => {
    const account: MailAccount = {
      address: ADDRESS,
      password: CANARY,
      imap_host: 'localhost',
      imap_port: imapPort,
      imap_mode: 'ssl',
      smtp_host: 'localhost',
      smtp_port: 465,
      smtp_mode: 'ssl',
    };
    // Written exactly as the installer writes it: email_env_text into the instance file.
    writeFileSync(accountFile, installerEnvText(account), { mode: 0o600 });
    const response = await fetch(`http://127.0.0.1:${String(AGENT_PORT)}/account`);
    const body = JSON.parse(await response.text());
    expect(body.connected).toBe(true);
    expect(body.address).toBe(ADDRESS);
    expect(body.imap_host).toBe('localhost');
    expect(body.imap_port).toBe(imapPort);
    expect(body.sign_in).toBe('ok');
  }, 30_000);

  it('an account saved through the agent is byte-for-byte what the installer writes', async () => {
    const changed: MailAccount = {
      address: ADDRESS,
      password: CANARY,
      imap_host: 'localhost',
      imap_port: imapPort,
      imap_mode: 'ssl',
      smtp_host: 'localhost',
      smtp_port: 587,
      smtp_mode: 'starttls',
    };
    const response = await fetch(`http://127.0.0.1:${String(AGENT_PORT)}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_key: 'other', ...changed }),
    });
    expect(response.status).toBe(200);
    const onDisk = readFileSync(accountFile, 'utf8');
    expect(onDisk).toBe(installerEnvText(changed));
    expect(onDisk).toBe(renderMailAccountEnv(changed));
    expect(fileValue(accountFile, 'MCP_EMAIL_SERVER_SMTP_PORT')).toBe('587');
    expect(fileValue(accountFile, 'MCP_EMAIL_SERVER_SMTP_START_SSL')).toBe('true');
    expect(fileValue(accountFile, 'MCP_EMAIL_SERVER_EMAIL_ADDRESS')).toBe(ADDRESS);
  }, 30_000);
});
