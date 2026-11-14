import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setUpSecrets } from './secretsSetup';

const PACKAGE_ROOT = path.resolve(__dirname, '../../..');

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('No TCP port');
  }
  return address.port;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for condition');
}

describe('startup without this computer key', () => {
  let dataDir: string;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'amn-locked-'));
  });

  afterEach(async () => {
    if (child !== undefined) {
      const exited = new Promise(resolve => child?.on('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('opens nothing and serves only the locked page, then opens by itself once setup has run', async () => {
    const port = await freePort();
    const base = `http://localhost:${String(port)}`;
    const sqlitePath = path.join(dataDir, 'db', 'db.sqlite');
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: PACKAGE_ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dataDir,
        NODE_OPTIONS: '--conditions=trueforge-dev',
        NODE_ENV: 'production',
        STANDALONE: 'true',
        HOST: 'localhost',
        PORT: String(port),
        ACCESS_LOGS: 'false',
        MEMORY_EMBEDDINGS_ENABLED: 'false',
        TRUEFORGE_AUTH_MODE: 'local',
        SQLITE_PATH: sqlitePath,
        SECRETS_KEY_FILE: path.join(dataDir, 'machine-key', 'master.key'),
        MEMORY_MARKDOWN_DIR: path.join(dataDir, 'memory'),
        PERSONA_KNOWLEDGE_DIR: path.join(dataDir, 'persona'),
        APP_DATA_DIR_SUFFIX: `startup-test-${path.basename(dataDir)}`,
      },
      stdio: 'ignore',
    });

    await waitFor(async () => (await fetch(`${base}/healthz`)).status === 503);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("waiting for this computer's key");
    const api = await fetch(`${base}/api/v1/auth/me`);
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: { code: 'locked' } });
    // Locked means locked: no database was made behind the page.
    expect(existsSync(sqlitePath)).toBe(false);

    await setUpSecrets({ dataDir, sqlitePath });
    await waitFor(async () => (await fetch(`${base}/healthz`)).status === 200);
    expect((await fetch(`${base}/api/v1/auth/me`)).status).toBe(401);
  }, 180_000);
});
