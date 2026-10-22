import { spawn, type ChildProcess } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { allowedRecipientsFileHash } from '../../../src/runtime/mailAllowedRecipients';

const ENTRYPOINT = resolve(__dirname, '../../../../../ops/compose/mail-email/entrypoint.sh');

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
  let wrapper: ChildProcess | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mail-entrypoint-'));
    policy = join(dir, 'allowed_recipients.toml');
    status = join(dir, 'status', 'loaded.sha256');
    starts = join(dir, 'starts.log');
    envLog = join(dir, 'env.log');
    await writeFile(policy, LIST_V1);
    await mkdir(join(dir, 'status'));
    // A stand-in server: it logs each start and then runs as the only process, so a signal reaches it.
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'mcp-email-server'),
      `#!/bin/sh\necho start >> "${starts}"\necho "\${MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS-unset}" >> "${envLog}"\nexec sleep 1000\n`,
    );
    await chmod(join(bin, 'mcp-email-server'), 0o755);
  });

  afterEach(async () => {
    if (wrapper !== undefined && wrapper.exitCode === null) {
      wrapper.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  });

  function startWrapper(extraEnv: Record<string, string> = {}): ChildProcess {
    wrapper = spawn('sh', [ENTRYPOINT, 'streamable-http', '--port', '9557'], {
      env: {
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        MCP_EMAIL_SERVER_CONFIG_PATH: policy,
        AMAN_MAIL_STATUS_FILE: status,
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
    expect(await readOrEmpty(envLog)).toBe('unset');
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
