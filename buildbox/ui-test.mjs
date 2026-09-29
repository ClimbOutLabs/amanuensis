#!/usr/bin/env node
/**
 * buildbox/ui-test.mjs — Playwright-based UI test runner for buildbox.
 *
 * This script:
 * 1. Boots the standalone Aman harness (backend + frontend)
 * 2. Launches a real Chromium browser via Playwright
 * 3. Types and clicks through the actual UI (not API calls)
 * 4. Takes screenshots at each step
 * 5. Verifies expected UI behavior
 * 6. Reports pass/fail
 *
 * Usage: node buildbox/ui-test.mjs --scenario <name> --job-id <id>
 *
 * Scenarios live in buildbox/scenarios/ui/<name>.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const scenarioName = args[args.indexOf('--scenario') + 1];
const jobId = args[args.indexOf('--job-id') + 1];

if (!scenarioName || !jobId) {
  console.error('Usage: node ui-test.mjs --scenario <name> --job-id <id>');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'out', scenarioName);
await mkdir(OUT_DIR, { recursive: true });

console.log(`[ui-test] Scenario: ${scenarioName}, Job: ${jobId}`);
console.log(`[ui-test] Output: ${OUT_DIR}`);

// Load the scenario
const scenarioPath = path.join(__dirname, 'scenarios', 'ui', `${scenarioName}.mjs`);
let scenario;
try {
  scenario = (await import(scenarioPath)).default;
} catch (e) {
  console.error(`[ui-test] Failed to load scenario: ${scenarioPath}`);
  console.error(e.message);
  process.exit(1);
}

// Boot Aman
console.log('[ui-test] Booting Aman...');
const aman = spawn('pnpm', ['standalone:dev'], {
  cwd: path.join(__dirname, '..', '..'),
  env: { ...process.env, STANDALONE: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let backendReady = false;
let frontendReady = false;

aman.stdout.on('data', (data) => {
  const line = data.toString();
  if (line.includes('8790') || line.includes('backend')) backendReady = true;
  if (line.includes('3000') || line.includes('frontend')) frontendReady = true;
});

aman.stderr.on('data', (data) => {
  // Log errors but don't fail immediately
  console.error(`[aman] ${data.toString().slice(0, 200)}`);
});

// Wait for Aman to boot (up to 120s)
console.log('[ui-test] Waiting for Aman to boot...');
const bootTimeout = 120000;
const bootStart = Date.now();
while (Date.now() - bootStart < bootTimeout) {
  try {
    const res = await fetch('http://localhost:8790/api/v1/health');
    if (res.ok) {
      console.log('[ui-test] Backend is up');
      backendReady = true;
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 2000));
}

if (!backendReady) {
  console.error('[ui-test] Backend failed to start within 120s');
  aman.kill();
  process.exit(1);
}

// Wait a bit more for frontend
await new Promise(r => setTimeout(r, 10000));

// Launch browser
console.log('[ui-test] Launching Chromium...');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

// Helper for screenshots
let shotNum = 0;
async function screenshot(name) {
  shotNum++;
  const filename = `shot-${String(shotNum).padStart(3, '0')}-${name}.png`;
  const filepath = path.join(OUT_DIR, filename);
  await page.screenshot({ path: filepath });
  console.log(`[ui-test] Screenshot: ${filename}`);
}

// Run the scenario
console.log(`[ui-test] Running scenario: ${scenarioName}`);
try {
  await scenario(page, { screenshot, jobId });
  console.log('[ui-test] Scenario PASSED');
} catch (e) {
  console.error('[ui-test] Scenario FAILED:', e.message);
  // Take a final screenshot on failure
  try {
    await screenshot('failure');
  } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  aman.kill();
  console.log('[ui-test] Done');
}
