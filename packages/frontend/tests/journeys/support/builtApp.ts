/** The built app with a real sign-in service beside it, as an installed Aman runs, for journey tests. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOGIN_CLIENT_SECRET_ENV,
  loginEnv,
  loginServiceConfig,
  readLoginServiceImage,
} from '../../../../../scripts/login-service-config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SERVER_DIR = join(REPO_ROOT, 'packages', 'trueforge');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'main.js');
const READY_TIMEOUT_MS = 120_000;
const CLIENT_ID = 'aman-journey';
const CLIENT_SECRET = 'journey-secret';

export interface BuiltApp {
  /** The address a person opens. */
  origin: string;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No free port could be found. Try again.');
  return address.port;
}

/** Stops a child and waits until it has gone, so the next step never races its port or files. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const forced = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await gone;
  clearTimeout(forced);
}

/** Waits for a 200 from `url`, failing early with the child's own output when it has already stopped. */
async function ready({ url, child, name }: { url: string; child: ChildProcess; name: string }): Promise<void> {
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let failed: Error | undefined;
  child.once('error', error => {
    failed = error;
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failed !== undefined) throw new Error(`${name} could not be started.`, { cause: failed });
    if (child.exitCode !== null) throw new Error(`${name} stopped before it was ready. Its last output:\n${output}`);
    const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      response => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(
    `${name} was not ready after ${String(READY_TIMEOUT_MS / 1000)} seconds. Its last output:\n${output}`,
  );
}

/**
 * Runs Dex with the one fixed person. It uses the Docker image the compose file pins. A machine
 * with no Docker sets AMAN_DEX_DIR to a folder that holds the `dex` program and its `web` folder.
 */
async function startLoginService({
  appOrigin,
  workDir,
}: {
  appOrigin: string;
  workDir: string;
}): Promise<{ issuer: string; child: ChildProcess }> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${String(port)}/dex`;
  const localDir = process.env['AMAN_DEX_DIR'];
  const local = localDir != null && localDir !== '';
  const configFile = join(workDir, 'dex.yaml');
  await writeFile(
    configFile,
    loginServiceConfig({
      issuer,
      listen: `${local ? '127.0.0.1' : '0.0.0.0'}:${String(port)}`,
      clientId: CLIENT_ID,
      redirectOrigins: [appOrigin],
      storage: { type: 'memory' },
      webDir: local ? join(localDir, 'web') : undefined,
    }),
  );
  // The image runs as its own user, which must be able to read the file.
  await chmod(configFile, 0o644);
  const env = { ...process.env, [LOGIN_CLIENT_SECRET_ENV]: CLIENT_SECRET };
  const child = local
    ? spawn(join(localDir, 'dex'), ['serve', configFile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(
        'docker',
        [
          'run',
          '--rm',
          '-p',
          `127.0.0.1:${String(port)}:${String(port)}`,
          '-v',
          `${configFile}:/etc/dex/config.yaml:ro`,
          '-e',
          LOGIN_CLIENT_SECRET_ENV,
          await readLoginServiceImage(REPO_ROOT),
          'dex',
          'serve',
          '/etc/dex/config.yaml',
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
  try {
    await ready({ url: `${issuer}/.well-known/openid-configuration`, child, name: 'The sign-in service' });
  } catch (error) {
    await stop(child);
    throw error;
  }
  return { issuer, child };
}

/**
 * Starts the sign-in service and the built server on free loopback ports, with an empty data folder.
 * Loopback model servers the journey uses must be listed, because the app refuses unlisted local addresses.
 */
export async function startBuiltApp({ localModelEndpoints }: { localModelEndpoints: string[] }): Promise<BuiltApp> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`The built app is missing at ${SERVER_ENTRY}. Run "pnpm build" first.`);
  }
  const workDir = await mkdtemp(join(tmpdir(), 'aman-journey-'));
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  const login = await startLoginService({ appOrigin: origin, workDir });
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ...loginEnv({ issuer: login.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      STANDALONE: 'true',
      NODE_ENV: 'production',
      NODE_OPTIONS: '',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      APP_DATA_DIR: join(workDir, 'data'),
      LOCAL_MODEL_ENDPOINTS: localModelEndpoints.join(','),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const close = async () => {
    await stop(server);
    await stop(login.child);
    await rm(workDir, { recursive: true, force: true });
  };
  try {
    await ready({ url: `${origin}/healthz`, child: server, name: 'The built app' });
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, close };
}
