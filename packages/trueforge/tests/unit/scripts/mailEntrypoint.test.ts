import { spawn, type ChildProcess } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { allowedRecipientsFileHash } from '../../../src/runtime/mailAllowedRecipients';

const ENTRYPOINT = resolve(__dirname, '../../../../../ops/compose/mail-email/entrypoint.sh');
const ACCOUNT_AGENT = resolve(__dirname, '../../../../../ops/compose/mail-email/account_agent.py');
const EMAIL_CHECK = resolve(__dirname, '../../../../../ops/compose/mail-email/email_check.py');

const LIST_V1 = 'db_location = "/data/db.sqlite3"\nallowed_recipients = ["dana@example.com"]\n';
const LIST_V2 = 'db_location = "/data/db.sqlite3"\nallowed_recipients = ["dana@example.com", "sam@example.com"]\n';

/** Waits until `check` passes, polling. Fails the test when it never does. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

describe('mail-email entrypoint wrapper', () => {
  let dir: string;
  let policy: string;
  let status: string;
  let starts: string;
  let envLog: string;
  let accountFile: string;
  let wrapper: ChildProcess | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-entrypoint-'));
    policy = join(dir, 'allowed_recipients.toml');
    status = join(dir, 'status', 'loaded.sha256');
    starts = join(dir, 'starts.log');
    envLog = join(dir, 'env.log');
    accountFile = join(dir, '.env.mail-email');
    await writeFile(policy, LIST_V1);
    await writeFile(accountFile, '');
    await mkdir(join(dir, 'status'));
    // A stand-in server: it logs each start and then runs as the only process, so a signal reaches it.
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'mcp-email-server'),
      `#!/bin/sh\necho start >> "${starts}"\necho "\${MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS-unset}" >> "${envLog}"\necho "addr:\${MCP_EMAIL_SERVER_EMAIL_ADDRESS-unset}" >> "${envLog}"\nexec sleep 1000\n`,
    );
    await chmod(join(bin, 'mcp-email-server'), 0o755);
  });

  afterEach(async () => {
    if (wrapper !== undefined && wrapper.exitCode === null) {
      // TERM lets the wrapper's trap stop the account agent and the server with it;
      // a bare KILL would leave the agent holding its port for the next test.
      const exited = new Promise(resolve => wrapper?.once('exit', resolve));
      wrapper.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3_000))]);
      if (wrapper.exitCode === null) {
        wrapper.kill('SIGKILL');
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  function startWrapper(extraEnv: Record<string, string> = {}): ChildProcess {
    wrapper = spawn('sh', [ENTRYPOINT, 'streamable-http', '--port', '9557'], {
      env: {
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        MCP_EMAIL_SERVER_CONFIG_PATH: policy,
        AMAN_MAIL_STATUS_FILE: status,
        AMAN_MAIL_ACCOUNT_FILE: accountFile,
        AMAN_MAIL_ACCOUNT_AGENT: ACCOUNT_AGENT,
        AMAN_MAIL_ACCOUNT_PORT: '19759',
        AMAN_MAIL_EMAIL_CHECK: EMAIL_CHECK,
        ...extraEnv,
      },
      stdio: 'ignore',
    });
    return wrapper;
  }

  async function startCount(): Promise<number> {
    return (await readOrEmpty(starts)).split('\n').filter(line => line === 'start').length;
  }

  it('records the hash of the list it started with', async () => {
    startWrapper();
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V1));
  }, 20_000);

  it('restarts when the list changes, and records the new hash after the restart', async () => {
    startWrapper();
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V1));
    const replacement = join(dir, 'next.toml');
    await writeFile(replacement, LIST_V2);
    await rename(replacement, policy);
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V2));
    expect(await startCount()).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('starts the server without an env recipient list, so the list file always decides', async () => {
    startWrapper({ MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS: 'stranger@example.net' });
    await eventually(async () => (await readOrEmpty(envLog)) !== '');
    expect((await readOrEmpty(envLog)).split('\n')[0]).toBe('unset');
  }, 20_000);

  it('restarts the server with the saved account when the account file changes', async () => {
    startWrapper();
    await eventually(async () => (await readOrEmpty(status)) !== '');
    expect(await readOrEmpty(envLog)).toContain('addr:unset');
    await writeFile(
      accountFile,
      [
        '# Written by the installer for the Email connector. Keep it private: it holds the app password.',
        'MCP_EMAIL_SERVER_EMAIL_ADDRESS=person@example.com',
        "MCP_EMAIL_SERVER_PASSWORD='<redacted>'",
        'MCP_EMAIL_SERVER_IMAP_HOST=imap.example.com',
        'MCP_EMAIL_SERVER_IMAP_PORT=993',
        'MCP_EMAIL_SERVER_IMAP_SSL=true',
        'MCP_EMAIL_SERVER_IMAP_START_SSL=false',
        'MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true',
        'MCP_EMAIL_SERVER_SMTP_HOST=smtp.example.com',
        'MCP_EMAIL_SERVER_SMTP_PORT=465',
        'MCP_EMAIL_SERVER_SMTP_SSL=true',
        'MCP_EMAIL_SERVER_SMTP_START_SSL=false',
        'MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true',
        '',
      ].join('\n'),
    );
    await eventually(async () => (await readOrEmpty(envLog)).includes('addr:person@example.com'));
    expect(await startCount()).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('logs that it is waiting for the send list, and starts once the list exists', async () => {
    await rm(policy);
    let output = '';
    const child = spawn('sh', [ENTRYPOINT, 'streamable-http', '--port', '9557'], {
      env: {
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        MCP_EMAIL_SERVER_CONFIG_PATH: policy,
        AMAN_MAIL_STATUS_FILE: status,
        AMAN_MAIL_ACCOUNT_FILE: accountFile,
        AMAN_MAIL_ACCOUNT_AGENT: ACCOUNT_AGENT,
        AMAN_MAIL_ACCOUNT_PORT: '19759',
        AMAN_MAIL_EMAIL_CHECK: EMAIL_CHECK,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    wrapper = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    await eventually(async () => output.includes('waiting for the send list'));
    expect(await startCount()).toBe(0);
    const firstList = join(dir, 'first.toml');
    await writeFile(firstList, LIST_V1);
    await rename(firstList, policy);
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V1));
    expect(await startCount()).toBeGreaterThanOrEqual(1);
    // Stop through the wrapper's own signal path, so the stand-in server stops with it and
    // no child is left holding this test's output pipe open.
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(child.exitCode).toBe(0);
  }, 20_000);

  it('stops the server when it is told to stop', async () => {
    const child = startWrapper();
    await eventually(async () => (await readOrEmpty(status)) !== '');
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(child.exitCode).toBe(0);
  }, 20_000);
});

describe('mail-email entrypoint bounded stop', () => {
  let dir: string;
  let policy: string;
  let status: string;
  let starts: string;
  let pidsFile: string;
  let accountFile: string;
  let wrapper: ChildProcess | undefined;
  let output: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-entrypoint-stop-'));
    policy = join(dir, 'allowed_recipients.toml');
    status = join(dir, 'status', 'loaded.sha256');
    starts = join(dir, 'starts.log');
    pidsFile = join(dir, 'pids.log');
    accountFile = join(dir, '.env.mail-email');
    output = '';
    wrapper = undefined;
    await writeFile(policy, LIST_V1);
    await writeFile(accountFile, '');
    await mkdir(join(dir, 'status'));
  });

  afterEach(async () => {
    if (wrapper !== undefined && wrapper.exitCode === null) {
      const exited = new Promise(resolve => wrapper?.once('exit', resolve));
      wrapper.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 8_000))]);
      if (wrapper.exitCode === null) {
        wrapper.kill('SIGKILL');
      }
    }
    // No stand-in server outlives its test, whichever way the wrapper went down.
    for (const line of (await readOrEmpty(pidsFile)).split('\n')) {
      const pid = Number.parseInt(line, 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes the stand-in server. A stubborn one ignores the stop signal; only a forced stop ends it. */
  async function writeStub(stubborn: boolean): Promise<void> {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const body = stubborn
      ? `#!/bin/sh\necho start >> "${starts}"\necho $$ >> "${pidsFile}"\ntrap '' TERM\nwhile :; do sleep 1; done\n`
      : `#!/bin/sh\necho start >> "${starts}"\necho $$ >> "${pidsFile}"\nexec sleep 1000\n`;
    await writeFile(join(bin, 'mcp-email-server'), body);
    await chmod(join(bin, 'mcp-email-server'), 0o755);
  }

  function startWrapperCaptured(extraEnv: Record<string, string> = {}): ChildProcess {
    const child = spawn('sh', [ENTRYPOINT, 'streamable-http', '--port', '9557'], {
      env: {
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        MCP_EMAIL_SERVER_CONFIG_PATH: policy,
        AMAN_MAIL_STATUS_FILE: status,
        AMAN_MAIL_ACCOUNT_FILE: accountFile,
        AMAN_MAIL_ACCOUNT_AGENT: ACCOUNT_AGENT,
        AMAN_MAIL_ACCOUNT_PORT: '19759',
        AMAN_MAIL_EMAIL_CHECK: EMAIL_CHECK,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    wrapper = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    return child;
  }

  async function startCount(): Promise<number> {
    return (await readOrEmpty(starts)).split('\n').filter(line => line === 'start').length;
  }

  async function serverPids(): Promise<number[]> {
    return (await readOrEmpty(pidsFile))
      .split('\n')
      .map(line => Number.parseInt(line, 10))
      .filter(pid => Number.isFinite(pid));
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function changeList(): Promise<void> {
    const replacement = join(dir, 'next.toml');
    await writeFile(replacement, LIST_V2);
    await rename(replacement, policy);
  }

  it('forces down a server that ignores the stop signal, restarts it, and records the new list', async () => {
    await writeStub(true);
    startWrapperCaptured({ AMAN_MAIL_STOP_GRACE_SECONDS: '2' });
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V1));
    const firstPid = (await serverPids())[0];
    if (firstPid === undefined) throw new Error('the stand-in server never recorded its pid');

    await changeList();
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V2), 25_000);

    expect(await startCount()).toBeGreaterThanOrEqual(2);
    expect(isAlive(firstPid)).toBe(false);
    // The stop, the forcing, and the start are all in the log, with the hashes that caused them.
    expect(output).toContain('the send list changed');
    expect(output).toContain(allowedRecipientsFileHash(LIST_V1));
    expect(output).toContain('did not stop within 2 seconds; forcing it down');
    expect(output).toContain(`mail server started (send list ${allowedRecipientsFileHash(LIST_V2)}`);
  }, 40_000);

  it('restarts a server that stops on the signal promptly, without forcing it down', async () => {
    await writeStub(false);
    startWrapperCaptured({ AMAN_MAIL_STOP_GRACE_SECONDS: '30' });
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V1));

    await changeList();
    // Well inside the 30 second grace: a stop that waited out the grace would miss this.
    await eventually(async () => (await readOrEmpty(status)) === allowedRecipientsFileHash(LIST_V2), 15_000);

    expect(await startCount()).toBeGreaterThanOrEqual(2);
    expect(output).toContain('the send list changed');
    expect(output).not.toContain('forcing it down');
  }, 30_000);
});
