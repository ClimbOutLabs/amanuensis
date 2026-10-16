import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const BOOT_TIMEOUT_MS = 40_000;

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

/** Plain http request, because fetch will not let a caller override the Host header. */
function statusOf(options: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: options.port, method: options.method, path: options.path, headers: options.headers },
      res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
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

describe('standalone login startup', () => {
  let dataDir: string;
  const running: Booted[] = [];
  const idps: Server[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'amn-login-'));
  });

  afterEach(async () => {
    for (const booted of running.splice(0)) {
      booted.child.kill('SIGKILL');
      await booted.exited;
    }
    for (const idp of idps.splice(0)) {
      await new Promise<void>(resolve => idp.close(() => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['localhost', {}],
    ['non-loopback', { HOST: '0.0.0.0' }],
    ['REQUIRE_AUTH=false', { REQUIRE_AUTH: 'false' }],
  ])('refuses to start without OIDC (%s) and names the missing settings', async (_label, extra) => {
    const booted = boot({ PORT: String(await freePort()), ...extra }, dataDir);
    running.push(booted);

    expect(await booted.exited).toBe(1);
    expect(booted.output()).toMatch(
      /Refusing to start without login.*OIDC_ISSUER_URL.*OIDC_CLIENT_ID.*OIDC_CLIENT_SECRET/,
    );
  });

  it.each([
    ['no allowed email', {}, /OIDC_ALLOWED_EMAILS must hold the email address of the owner/],
    [
      'two allowed emails',
      { OIDC_ALLOWED_EMAILS: 'owner@example.invalid,guest@example.invalid' },
      /lists 2 addresses.*exactly one account/,
    ],
  ])('refuses to start with OIDC and %s', async (_label, extra, message) => {
    const booted = boot(
      {
        PORT: String(await freePort()),
        OIDC_ISSUER_URL: `http://127.0.0.1:${String(await freePort())}/dex`,
        OIDC_CLIENT_ID: 'client-a',
        OIDC_CLIENT_SECRET: 'secret-a',
        ...extra,
      },
      dataDir,
    );
    running.push(booted);

    expect(await booted.exited).toBe(1);
    expect(booted.output()).toMatch(message);
  });

  it('starts when the home directory cannot be created, keeping its data under APP_DATA_DIR', async () => {
    const port = await freePort();
    // A path below a regular file can never be created, as for a runtime user whose home directory is missing.
    const blocker = path.join(dataDir, 'not-a-directory');
    await writeFile(blocker, '');
    const appDataDir = path.join(dataDir, 'app');
    const booted = boot(
      {
        PORT: String(port),
        HOME: path.join(blocker, 'home'),
        APP_DATA_DIR: appDataDir,
        OIDC_ISSUER_URL: `http://127.0.0.1:${String(await freePort())}/dex`,
        OIDC_CLIENT_ID: 'client-a',
        OIDC_CLIENT_SECRET: 'secret-a',
        OIDC_ALLOWED_EMAILS: 'owner@example.invalid',
      },
      dataDir,
    );
    running.push(booted);

    await waitFor(async () => (await fetch(`http://localhost:${String(port)}/healthz`)).status === 200);

    expect(booted.output()).not.toMatch(/Failed to start server/);
    expect(await readdir(appDataDir)).toContain('sandboxes');
  }, 90_000);

  it('boots with an unreachable issuer, serves 401 and the retry page, guards Host and Origin, then logs in once the issuer appears', async () => {
    const port = await freePort();
    const idpPort = await freePort();
    const base = `http://localhost:${String(port)}`;
    const booted = boot(
      {
        PORT: String(port),
        OIDC_ISSUER_URL: `http://127.0.0.1:${String(idpPort)}/dex`,
        OIDC_CLIENT_ID: 'client-a',
        OIDC_CLIENT_SECRET: 'secret-a',
        OIDC_ALLOWED_EMAILS: 'owner@example.invalid',
        AUTH_COOKIE_SUFFIX: '_a',
      },
      dataDir,
    );
    running.push(booted);

    await waitFor(async () => (await fetch(`${base}/healthz`)).status === 200);

    expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(401);
    const unavailable = await fetch(`${base}/api/v1/auth/login`, { redirect: 'manual' });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain('Login unavailable, retrying');

    expect(await statusOf({ port, method: 'GET', path: '/api/v1/sessions', headers: { host: 'evil.example' } })).toBe(
      421,
    );
    expect(
      await statusOf({
        port,
        method: 'POST',
        path: '/api/v1/sessions',
        headers: { host: `localhost:${String(port)}`, origin: 'https://evil.example' },
      }),
    ).toBe(403);

    const idp = createServer((req, res) => {
      const issuer = `http://127.0.0.1:${String(idpPort)}/dex`;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/dex/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/keys`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          }),
        );
      } else {
        res.end(JSON.stringify({ keys: [] }));
      }
    });
    idps.push(idp);
    await new Promise<void>(resolve => idp.listen(idpPort, '127.0.0.1', resolve));

    let location: string | null = null;
    let cookies: string[] = [];
    await waitFor(async () => {
      const res = await fetch(`${base}/api/v1/auth/login`, { redirect: 'manual' });
      location = res.headers.get('location');
      cookies = res.headers.getSetCookie();
      return res.status === 302;
    });

    expect(location).toContain(`http://127.0.0.1:${String(idpPort)}/dex/auth`);
    expect(location).toContain(encodeURIComponent(`${base}/api/v1/auth/callback`));
    expect(cookies[0]).toMatch(/^oauth_state_a=/);
  }, 90_000);
});
