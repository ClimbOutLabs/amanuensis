#!/usr/bin/env node
/**
 * buildbox/ui-test.mjs - Aman boot + browser journey with diagnostics
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PW_ROOT = '/home/user/buildbox-playwright';
const TRUEFORGE_DIR = join(REPO_ROOT, 'packages/trueforge');

const args = process.argv.slice(2);
const scenario = args[args.indexOf('--scenario') + 1] || 'smoke';
const jobId = args[args.indexOf('--job-id') + 1] || 'unknown';

console.log(`[ui-test] scenario=${scenario} job=${jobId}`);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(url, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function main() {
  if (scenario === 'smoke') {
    const pw = await import(`${PW_ROOT}/node_modules/playwright/index.mjs`);
    const browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.goto('data:text/html,<h1>OK</h1>');
    const c = await page.content();
    await browser.close();
    const pass = c.includes('OK');
    console.log(pass ? '[ui-test] SMOKE PASS' : '[ui-test] SMOKE FAIL');
    process.exit(pass ? 0 : 1);
  }

  // Full Aman test with diagnostics
  console.log('[ui-test] === Starting Aman backend ===');

  // Check .env
  const envPath = join(TRUEFORGE_DIR, '.env');
  if (!existsSync(envPath)) {
    console.log('[ui-test] No .env found, creating minimal test .env');
    writeFileSync(
      envPath,
      ['NODE_ENV=development', 'PORT=8790', '# Minimal test env - add real values as needed'].join('\n') + '\n',
    );
  } else {
    console.log('[ui-test] .env exists');
  }

  // Start backend directly, capture output to file
  const backendLog = `/tmp/ui-test-backend-${jobId}.log`;
  console.log(`[ui-test] Backend log: ${backendLog}`);

  const backend = spawn('npx', ['tsx', 'src/main.ts'], {
    cwd: TRUEFORGE_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NODE_OPTIONS: '--conditions=trueforge-dev',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let backendOutput = '';
  backend.stdout.on('data', d => {
    const s = d.toString();
    backendOutput += s;
    try {
      appendFileSync(backendLog, s);
    } catch {}
  });
  backend.stderr.on('data', d => {
    const s = d.toString();
    backendOutput += s;
    try {
      appendFileSync(backendLog, s);
    } catch {}
  });

  backend.on('error', e => {
    console.error(`[ui-test] Backend spawn error: ${e.message}`);
  });

  backend.on('exit', code => {
    console.error(`[ui-test] Backend exited with code ${code}`);
    console.error('[ui-test] Last 2000 chars of backend output:');
    console.error(backendOutput.slice(-2000));
  });

  // Wait for backend (60s)
  console.log('[ui-test] Waiting for backend on :8790...');
  const backendOk = await waitFor('http://localhost:8790/api/v1/health', 60000, 'backend');

  if (!backendOk) {
    console.error('[ui-test] BACKEND FAILED TO START');
    console.error('[ui-test] === Backend output (last 5000 chars) ===');
    console.error(backendOutput.slice(-5000) || '(no output captured)');
    console.error('[ui-test] === End backend output ===');
    backend.kill('SIGTERM');
    process.exit(1);
  }

  console.log('[ui-test] Backend ready!');

  // Start frontend
  console.log('[ui-test] === Starting frontend ===');
  const frontend = spawn('pnpm', ['--filter', 'frontend', 'dev'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  frontend.stdout.on('data', () => {}); // Discard, too noisy
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  frontend.stderr.on('data', () => {});

  const frontendOk = await waitFor('http://localhost:3000', 120000, 'frontend');
  if (!frontendOk) {
    console.error('[ui-test] Frontend failed to start');
    backend.kill('SIGTERM');
    frontend.kill('SIGTERM');
    process.exit(1);
  }

  console.log('[ui-test] Frontend ready!');
  await sleep(3000);

  // Browser test
  console.log('[ui-test] === Browser test ===');
  const pw = await import(`${PW_ROOT}/node_modules/playwright/index.mjs`);
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let exitCode = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text().slice(0, 200));
    });
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));

    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const shotPath = `/tmp/ui-test-${jobId}.png`;
    await page.screenshot({ path: shotPath });
    console.log(`[ui-test] Screenshot: ${shotPath}`);

    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log(`[ui-test] Title: ${title}`);

    if (errors.length > 0) {
      console.log(`[ui-test] Console errors (${errors.length}):`);
      errors.slice(0, 5).forEach(e => console.log(`  - ${e}`));
    }

    if (bodyText.length > 10 && errors.filter(e => e.includes('500')).length === 0) {
      console.log('[ui-test] JOURNEY PASS');
    } else {
      console.error('[ui-test] JOURNEY FAIL: Page empty or backend errors');
      console.error(
        `[ui-test] Body length: ${bodyText.length}, 500 errors: ${errors.filter(e => e.includes('500')).length}`,
      );
      exitCode = 1;
    }
  } catch (e) {
    console.error(`[ui-test] JOURNEY FAIL: ${e.message}`);
    exitCode = 1;
  } finally {
    await browser.close();
    backend.kill('SIGTERM');
    frontend.kill('SIGTERM');
    await sleep(2000);
    try {
      backend.kill('SIGKILL');
    } catch {}
    try {
      frontend.kill('SIGKILL');
    } catch {}
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(`[ui-test] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
