import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';
const BOOT_TIMEOUT_MS = 60_000;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address == null || typeof address === 'string') throw new Error('Probe did not bind a TCP port');
  const { port } = address;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Boots the real server in local sign-in mode against a throwaway data directory. */
async function bootLocalServer(dataDir: string, port: number): Promise<ChildProcess> {
  const trueforgeRoot = fileURLToPath(new URL('../../trueforge/', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: trueforgeRoot,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dataDir,
      NODE_OPTIONS: '--conditions=trueforge-dev',
      NODE_ENV: 'production',
      STANDALONE: 'true',
      TRUEFORGE_AUTH_MODE: 'local',
      HOST: 'localhost',
      PORT: String(port),
      ACCESS_LOGS: 'false',
      MEMORY_EMBEDDINGS_ENABLED: 'false',
      SQLITE_PATH: path.join(dataDir, 'db', 'db.sqlite'),
      MEMORY_MARKDOWN_DIR: path.join(dataDir, 'memory'),
      PERSONA_KNOWLEDGE_DIR: path.join(dataDir, 'persona'),
      APP_DATA_DIR_SUFFIX: `auth-local-test-${path.basename(dataDir)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://localhost:${String(port)}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before ready (code=${String(child.exitCode)})`);
    }
    try {
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (health.ok) {
        return child;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('Server did not become ready');
    }
    await delay(250);
  }
}

test('local sign-in: create, sign out, wrong password, sign in', { timeout: 240_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'amn-auth-local-'));
  const port = await freePort();
  const base = `http://localhost:${String(port)}`;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    server = await bootLocalServer(dataDir, port);
    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const page = await browser.newPage();

    // First run: the create form, and creating it signs the person in.
    await page.goto(`${base}/api/v1/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your sign-in' }).waitFor({ state: 'visible' });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Type the password again').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create sign-in' }).click();
    await page.waitForURL(`${base}/`);

    // Signed in: the login page sends the person straight through.
    await page.goto(`${base}/api/v1/auth/login`, { waitUntil: 'domcontentloaded' });
    assert.equal(page.url(), `${base}/`);

    // Sign out through the same route the app uses, then the form is a plain sign-in.
    await page.evaluate(async () => {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    });
    await page.goto(`${base}/api/v1/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sign in' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: 'Create your sign-in' }).count(), 0);

    // A wrong password gets the one refusal sentence.
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('That email or password is not right').waitFor({ state: 'visible' });

    // The right password signs in.
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${base}/`);
  } finally {
    await browser?.close();
    if (server !== undefined) {
      server.kill('SIGKILL');
      await new Promise<void>(resolve => server.once('exit', () => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
