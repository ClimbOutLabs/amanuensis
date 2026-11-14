/**
 * Runs a packed `amanuensis` tarball the way a person gets it: through `npx`, from a folder with
 * no node_modules and no monorepo above it, with local sign-in.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const win32 = platform === 'win32';
export const shell = win32 ? { shell: true } : {};
const host = '127.0.0.1';

export function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** True while any process of the app's group is still running. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function waitFor(condition, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await delay(200);
  }
  return condition();
}

/** Stops npx and the app it started, and returns once none of them is running. */
async function stopApp(child) {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (win32) {
    try {
      // /T takes the whole tree and /F ends it at once; the call returns when they are gone.
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
    await waitFor(exited, 30_000);
    return;
  }
  const signalGroup = signal => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  signalGroup('SIGTERM');
  if (await waitFor(() => exited() && !groupAlive(pid), 30_000)) {
    return;
  }
  console.warn('The packed app did not stop within 30 seconds of SIGTERM; stopping it with SIGKILL.');
  signalGroup('SIGKILL');
  if (!(await waitFor(() => exited() && !groupAlive(pid), 10_000))) {
    throw new Error(`The packed app (process group ${String(pid)}) is still running after SIGKILL.`);
  }
}

/**
 * Starts one tarball on a data folder and waits until it answers. The launch carries no sign-in
 * configuration, so the app uses local sign-in. `stop` returns once every process it started has
 * stopped, so the data folder is safe to reuse or remove after it.
 */
export async function startPackedApp({ tarballPath, dataDir, port }) {
  const origin = `http://${host}:${String(port)}`;
  const consumerDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-npx-'));
  const tarballName = path.basename(tarballPath);
  // npx takes the tarball relative to cwd: an absolute path can be read as a registry spec.
  await cp(tarballPath, path.join(consumerDir, tarballName));

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('OIDC_') || key === 'TRUEFORGE_AUTH_MODE') {
      continue;
    }
    env[key] = value;
  }
  const child = spawn('npx', ['--yes', `./${tarballName}`, '--port', String(port)], {
    cwd: consumerDir,
    env: {
      ...env,
      HOST: host,
      // Everything the app keeps goes under the data folder, so a later start on the same
      // folder finds the files as well as the database.
      SQLITE_PATH: path.join(dataDir, 'db.sqlite'),
      APP_DATA_DIR: dataDir,
      MEMORY_MARKDOWN_DIR: path.join(dataDir, 'memory'),
      PERSONA_KNOWLEDGE_DIR: path.join(dataDir, 'persona-knowledge'),
      NODE_ENV: 'production',
      // npx keeps an install under the tarball's file name, so a second tarball with the same
      // name would run the first one's code. Each start gets a cache of its own.
      npm_config_cache: path.join(consumerDir, 'npm-cache'),
    },
    stdio: 'inherit',
    // Its own process group, so cleanup can stop npx and the app it starts together.
    detached: !win32,
    ...shell,
  });
  const stop = async () => {
    await stopApp(child);
    await rm(consumerDir, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 180_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`CLI exited before ready (code=${String(child.exitCode)})`);
      }
      try {
        const signal = globalThis.AbortSignal.timeout(2_000);
        const [health, ui] = await Promise.all([
          globalThis.fetch(`${origin}/healthz`, { signal }),
          globalThis.fetch(`${origin}/`, { signal }),
        ]);
        const html = await ui.text();
        if (health.ok && ui.ok && html.includes('id="root"')) {
          return { origin, stop };
        }
        lastError = new Error(`healthz=${String(health.status)} ui=${String(ui.status)}`);
      } catch (error) {
        lastError = error;
      }
      await delay(500);
    }
    throw new Error('packed CLI did not become ready', { cause: lastError });
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The session cookie pair from a response's Set-Cookie headers, for the next request's Cookie header. */
export function sessionCookie(response) {
  const raw = response.headers.getSetCookie();
  const pair = raw.map(header => header.split(';')[0]).find(part => part.startsWith('id_token='));
  check(pair !== undefined, 'the response set no id_token cookie');
  return pair;
}

export async function formPost({ origin, pathname, fields, cookie }) {
  return globalThis.fetch(`${origin}${pathname}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: new globalThis.URLSearchParams(fields).toString(),
  });
}
