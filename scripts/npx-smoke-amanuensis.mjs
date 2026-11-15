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
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, formPost, sessionCookie, shell, startPackedApp } from './packed-app.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18_790;
const packDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-pack-'));
const dataDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-data-'));

const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';
const WRONG_CREDENTIALS_LINE = 'That email or password is not right';

async function checkLocalSignIn(origin) {
  const loginPage = await globalThis.fetch(`${origin}/api/v1/auth/login`);
  const loginHtml = await loginPage.text();
  check(loginPage.status === 200, `first login page answered ${String(loginPage.status)}`);
  check(loginHtml.includes('Create your sign-in'), 'first login page did not offer to create the sign-in');

  const created = await formPost({
    origin,
    pathname: '/api/v1/auth/create-account',
    fields: { email: EMAIL, password: PASSWORD, password_confirm: PASSWORD },
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

  const wrong = await formPost({
    origin,
    pathname: '/api/v1/auth/login',
    fields: { email: EMAIL, password: 'not the password' },
  });
  const wrongHtml = await wrong.text();
  check(wrong.status === 401, `wrong password answered ${String(wrong.status)}`);
  check(wrongHtml.includes(WRONG_CREDENTIALS_LINE), 'wrong password did not get the one refusal line');

  const signedIn = await formPost({
    origin,
    pathname: '/api/v1/auth/login',
    fields: { email: EMAIL, password: PASSWORD },
  });
  await signedIn.text();
  check(signedIn.status === 302, `signing in answered ${String(signedIn.status)}`);
  cookie = sessionCookie(signedIn);
  const meAgain = await globalThis.fetch(`${origin}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  await meAgain.json();
  check(meAgain.status === 200, `me after sign-in answered ${String(meAgain.status)}`);
  console.log('packed amanuensis CLI local sign-in OK: create, sign out, wrong password, sign in');
}

let app;
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
  app = await startPackedApp({ tarballPath: path.join(packDir, tarballName), dataDir, port });
  console.log('packed amanuensis CLI healthz and UI OK');
  await checkLocalSignIn(app.origin);
} finally {
  // The app may still be writing into the data folder (the memory model download, for one), so the
  // folders are only removed once every process it started has stopped.
  await app?.stop();
  await rm(packDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
