import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
// A cold tsx boot of the whole server takes well over half a minute on a loaded machine.
const BOOT_TIMEOUT_MS = 120_000;

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server is not listening on a TCP port');
  }
  return address.port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = portOf(probe);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface Booted {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function boot(env: Record<string, string>, dataDir: string): Booted {
  let collected = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dataDir,
      NODE_OPTIONS: '--conditions=trueforge-dev',
      NODE_ENV: 'production',
      STANDALONE: 'true',
      HOST: 'localhost',
      ACCESS_LOGS: 'false',
      MEMORY_EMBEDDINGS_ENABLED: 'false',
      SQLITE_PATH: path.join(dataDir, 'db', 'db.sqlite'),
      MEMORY_MARKDOWN_DIR: path.join(dataDir, 'memory'),
      PERSONA_KNOWLEDGE_DIR: path.join(dataDir, 'persona'),
      APP_DATA_DIR_SUFFIX: `startup-test-${path.basename(dataDir)}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, output: () => collected, exited };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for condition');
}

describe('local sign-in startup', () => {
  let dataDir: string;
  const running: Booted[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'amn-local-login-'));
  });

  afterEach(async () => {
    for (const booted of running.splice(0)) {
      booted.child.kill('SIGKILL');
      await booted.exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a plain-http non-loopback public address, with the one sentence', async () => {
    const port = await freePort();
    const booted = boot(
      {
        PORT: String(port),
        TRUEFORGE_AUTH_MODE: 'local',
        PUBLIC_BASE_URL: `http://192.0.2.10:${String(port)}`,
      },
      dataDir,
    );
    running.push(booted);

    expect(await booted.exited).toBe(1);
    expect(booted.output()).toContain(
      'Local sign-in works on this computer or behind https. Set PUBLIC_BASE_URL to an https address, or use the Docker install.',
    );
  });

  it('boots on this computer with no OIDC at all and serves the create form', async () => {
    const port = await freePort();
    const base = `http://localhost:${String(port)}`;
    const booted = boot({ PORT: String(port), TRUEFORGE_AUTH_MODE: 'local' }, dataDir);
    running.push(booted);

    await waitFor(async () => (await fetch(`${base}/healthz`)).status === 200);

    expect(booted.output()).toContain('Local sign-in is on');
    expect((await fetch(`${base}/api/v1/auth/me`)).status).toBe(401);

    const login = await fetch(`${base}/api/v1/auth/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('Create your sign-in');
  }, 180_000);
});
