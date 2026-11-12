/**
 * Proves the `amanuensis` tarball runs the way a user gets it: packed, then launched through
 * `npx` from a directory with no node_modules and no monorepo above it.
 *
 * Separate from `npx-smoke.mjs`, which packs the three upstream packages and runs the installed
 * entry point directly. That file comes from upstream and is rewritten by every sync, so the
 * fork's own check lives here instead.
 *
 * The launch carries no sign-in configuration at all: the npx install defaults to local
 * sign-in, so the check drives the whole first-run story over HTTP: the create form,
 * creating the one sign-in, signing out, a wrong password, and signing back in.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win32 = platform === 'win32';
const shell = win32 ? { shell: true } : {};
const host = '127.0.0.1';
const port = 18_790;
const origin = `http://${host}:${String(port)}`;
const packDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-pack-'));
const consumerDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-npx-'));
const dataDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-data-'));
let child;

const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';
const WRONG_CREDENTIALS_LINE = 'That email or password is not right';

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
async function stopApp() {
  const pid = child?.pid;
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

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** The session cookie pair from a response's Set-Cookie headers, for the next request's Cookie header. */
function sessionCookie(response) {
  const raw = response.headers.getSetCookie();
  const pair = raw.map(header => header.split(';')[0]).find(part => part.startsWith('id_token='));
  check(pair !== undefined, 'the response set no id_token cookie');
  return pair;
}

async function formPost(pathname, fields, cookie) {
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

async function checkLocalSignIn() {
  const loginPage = await globalThis.fetch(`${origin}/api/v1/auth/login`);
  const loginHtml = await loginPage.text();
  check(loginPage.status === 200, `first login page answered ${String(loginPage.status)}`);
  check(loginHtml.includes('Create your sign-in'), 'first login page did not offer to create the sign-in');

  const created = await formPost('/api/v1/auth/create-account', {
    email: EMAIL,
    password: PASSWORD,
    password_confirm: PASSWORD,
  });
  await created.text();
  check(created.status === 302, `creating the sign-in answered ${String(created.status)}`);
  let cookie = sessionCookie(created);

  const me = await globalThis.fetch(`${origin}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  const meBody = await me.json();
  check(me.status === 200, `me after create answered ${String(me.status)}`);
  check(meBody?.data?.type === 'local-connected', 'me did not report a local-connected session');

  const logout = await globalThis.fetch(`${origin}/api/v1/auth/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin },
  });
  await logout.text();
  check(logout.status === 204, `logout answered ${String(logout.status)}`);

  const signInPage = await globalThis.fetch(`${origin}/api/v1/auth/login`);
  const signInHtml = await signInPage.text();
  check(signInPage.status === 200, `login page after create answered ${String(signInPage.status)}`);
  check(!signInHtml.includes('Create your sign-in'), 'login page still offered to create the sign-in');

  const wrong = await formPost('/api/v1/auth/login', { email: EMAIL, password: 'not the password' });
  const wrongHtml = await wrong.text();
  check(wrong.status === 401, `wrong password answered ${String(wrong.status)}`);
  check(wrongHtml.includes(WRONG_CREDENTIALS_LINE), 'wrong password did not get the one refusal line');

  const signedIn = await formPost('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  await signedIn.text();
  check(signedIn.status === 302, `signing in answered ${String(signedIn.status)}`);
  cookie = sessionCookie(signedIn);
  const meAgain = await globalThis.fetch(`${origin}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  await meAgain.json();
  check(meAgain.status === 200, `me after sign-in answered ${String(meAgain.status)}`);
  console.log('packed amanuensis CLI local sign-in OK: create, sign out, wrong password, sign in');
}

try {
  execFileSync('pnpm', ['--filter', 'amanuensis', 'pack', '--pack-destination', packDir], {
    cwd: rootDir,
    stdio: 'pipe',
    ...shell,
  });

  const [tarballName] = (await readdir(packDir)).filter(name => name.endsWith('.tgz'));
  if (tarballName === undefined) {
    throw new Error(`pnpm pack produced no tarball in ${packDir}`);
  }
  // npx takes the tarball relative to cwd: an absolute path can be read as a registry spec.
  await cp(path.join(packDir, tarballName), path.join(consumerDir, tarballName));

  // The default is what is being proved: no sign-in configuration of any kind.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('OIDC_') || key === 'TRUEFORGE_AUTH_MODE') {
      continue;
    }
    env[key] = value;
  }
  child = spawn('npx', ['--yes', `./${tarballName}`, '--port', String(port)], {
    cwd: consumerDir,
    env: {
      ...env,
      HOST: host,
      SQLITE_PATH: path.join(dataDir, 'db.sqlite'),
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
    // Its own process group, so cleanup can stop npx and the app it starts together.
    detached: !win32,
    ...shell,
  });

  const deadline = Date.now() + 180_000;
  let lastError;
  let ready = false;
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
        ready = true;
        break;
      }
      lastError = new Error(`healthz=${String(health.status)} ui=${String(ui.status)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  if (!ready) {
    throw new Error('packed CLI did not become ready', { cause: lastError });
  }
  console.log('packed amanuensis CLI healthz and UI OK');
  await checkLocalSignIn();
} finally {
  // The app may still be writing into the data folder (the memory model download, for one), so the
  // folders are only removed once every process it started has stopped.
  await stopApp();
  await rm(packDir, { recursive: true, force: true });
  await rm(consumerDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
