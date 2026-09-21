/**
 * Proves the `amanuensis` tarball runs the way a user gets it: packed, then launched through
 * `npx` from a directory with no node_modules and no monorepo above it.
 *
 * Separate from `npx-smoke.mjs`, which packs the three upstream packages and runs the installed
 * entry point directly. That file comes from upstream and is rewritten by every sync, so the
 * fork's own check lives here instead.
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

  child = spawn('npx', ['--yes', `./${tarballName}`, '--port', String(port)], {
    cwd: consumerDir,
    env: {
      ...process.env,
      HOST: host,
      SQLITE_PATH: path.join(dataDir, 'db.sqlite'),
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
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
} finally {
  if (child?.pid !== undefined) {
    try {
      if (win32) {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // Already gone.
    }
  }
  await rm(packDir, { recursive: true, force: true });
  await rm(consumerDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
