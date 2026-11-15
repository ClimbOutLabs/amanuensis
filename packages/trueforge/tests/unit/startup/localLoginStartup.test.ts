import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
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

interface FormResponse {
  status: number;
  setCookie: string;
  body: string;
}

/**
 * A form post over raw http, so the test controls every header: fetch would speak for the
 * caller, and this test exists to prove what the server does with no Origin at all.
 */
function formPost(url: string, fields: Record<string, string>, headers: Record<string, string>): Promise<FormResponse> {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      res => {
        let collected = '';
        res.on('data', (chunk: Buffer) => (collected += chunk.toString()));
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            setCookie: Array.isArray(setCookie) ? setCookie.join('\n') : '',
            body: collected,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
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

/**
 * Waits until the server this test started is the one answering. The port was free a moment ago, but another
 * test may take it first; that server's health page must not count, so the child has to say it is listening.
 */
async function waitUntilServing({ booted, base }: { booted: Booted; base: string }): Promise<void> {
  let exitCode: number | null | undefined;
  void booted.exited.then(code => {
    exitCode = code;
  });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      throw new Error(`The server stopped before it was ready (exit ${String(exitCode)}):\n${booted.output()}`);
    }
    if (booted.output().includes('Agent server listening on')) {
      const healthy = await fetch(`${base}/healthz`).then(
        response => response.status === 200,
        () => false,
      );
      if (healthy) {
        return;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the server to be ready:\n${booted.output()}`);
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

    await waitUntilServing({ booted, base });

    expect(booted.output()).toContain('Local sign-in is on');
    expect((await fetch(`${base}/api/v1/auth/me`)).status).toBe(401);

    const login = await fetch(`${base}/api/v1/auth/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('Create your sign-in');
  }, 180_000);

  it('refuses a create with no Origin, and lets the same create through with the page own Origin', async () => {
    const port = await freePort();
    const base = `http://localhost:${String(port)}`;
    const booted = boot({ PORT: String(port), TRUEFORGE_AUTH_MODE: 'local' }, dataDir);
    running.push(booted);

    await waitUntilServing({ booted, base });

    const fields = {
      email: 'owner@example.com',
      password: 'a long enough password',
      password_confirm: 'a long enough password',
    };
    const refused = await formPost(`${base}/api/v1/auth/create-account`, fields, {});
    expect(refused.status).toBe(403);

    // The refused create stored nothing: the create form is still on offer.
    const login = await fetch(`${base}/api/v1/auth/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('Create your sign-in');

    const created = await formPost(`${base}/api/v1/auth/create-account`, fields, { Origin: base });
    expect(created.status).toBe(302);
    expect(created.setCookie).toContain('id_token=');
  }, 180_000);
});
