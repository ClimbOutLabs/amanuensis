// `pnpm eval:models:fresh`: starts a throwaway eval Aman from this checkout, signs in to it, runs the
// model eval against it, then stops it and deletes its data. Token Factory models need NEBIUS_API_KEY
// in the environment; the key goes only to the throwaway instance.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URLSearchParams } from 'node:url';
import { DEFAULT_ROOT_DIR } from '../eval-tokens/cli.mjs';
import { main as runModels } from './cli.mjs';

const START_TIMEOUT_MS = 5 * 60 * 1000;
const EVAL_EMAIL = 'eval@example.com';
/** Settings the throwaway instance may take from the caller, besides the fixed ones below. */
const PASSED_SETTINGS = [
  'NEBIUS_API_KEY',
  'TOKEN_FACTORY_BASE_URL',
  'TOKEN_FACTORY_MODEL',
  'TOKEN_FACTORY_PRICES',
  'PATH',
  'HOME',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  if (address === null || typeof address === 'string') {
    throw new Error('Could not find a free port for the eval instance. Close other servers and try again.');
  }
  return address.port;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} stopped with code ${String(code)}.`)),
    );
  });
}

async function waitForHealth({ origin, child }) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('The eval instance stopped while starting. Read its log above for the reason.');
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  throw new Error('The eval instance did not start within 5 minutes. Read its log above for the reason.');
}

/** Creates the instance's one sign-in and returns its session token. The token is never printed. */
export async function createSignIn({ origin, fetchImpl = fetch }) {
  const password = randomBytes(24).toString('hex');
  const response = await fetchImpl(`${origin}/api/v1/auth/create-account`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ email: EVAL_EMAIL, password, password_confirm: password }).toString(),
  });
  const cookie = response.headers.getSetCookie().find(line => line.startsWith('id_token='));
  const token = cookie?.slice('id_token='.length).split(';')[0];
  if (token === undefined || token === '') {
    throw new Error(
      `The eval instance did not sign in (HTTP ${String(response.status)}). Start from a fresh instance and try again.`,
    );
  }
  return token;
}

/**
 * @param {{ argv: readonly string[], env?: Record<string, string | undefined>, stdout: (text: string) => void, stderr: (text: string) => void, rootDir?: string }} options
 */
export async function main({ argv, env = process.env, stdout, stderr, rootDir = DEFAULT_ROOT_DIR }) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (args.includes('--instance')) {
    stderr('eval:models:fresh starts its own instance. Leave out --instance, or use pnpm eval:models instead.\n');
    return 2;
  }
  if (args.includes('--help') || args.includes('-h')) {
    return runModels({ argv: ['--help'], env, stdout, stderr, rootDir });
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'aman-eval-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const serverEnv = Object.fromEntries(
    PASSED_SETTINGS.filter(key => env[key] !== undefined).map(key => [key, env[key]]),
  );
  Object.assign(serverEnv, {
    AMAN_EVAL_MODE: 'true',
    TRUEFORGE_AUTH_MODE: 'local',
    APP_DATA_DIR: dataDir,
    PORT: String(port),
  });
  const trueforge = path.join(rootDir, 'packages', 'trueforge');
  let child;
  try {
    stderr('Preparing the eval instance...\n');
    await run('pnpm', ['run', 'build:gen'], {
      cwd: trueforge,
      env: { ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child = spawn('pnpm', ['run', 'serve:eval'], {
      cwd: trueforge,
      env: serverEnv,
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForHealth({ origin, child });
    const token = await createSignIn({ origin });
    stderr(`Eval instance ready at ${origin}.\n`);
    return await runModels({
      argv: ['--instance', origin, ...args],
      env: { ...env, TRUEFORGE_TOKEN: token },
      stdout,
      stderr,
      rootDir,
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : 'The eval stopped for an unknown reason.'}\n`);
    return 1;
  } finally {
    if (child?.pid !== undefined && child.exitCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await sleep(2000);
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}
