#!/usr/bin/env node
/**
 * buildbox/run-scenarios.mjs
 *
 * Drives one scripted assistant scenario against a local standalone Amanuensis
 * harness backed by the Spark model, then captures UI screenshots.
 *
 * Usage: node buildbox/run-scenarios.mjs --scenario <name>
 *
 * The scenario file lives at buildbox/scenarios/<name>.json and describes:
 *   - an optional persona to create and attach to the session
 *   - a list of user turns to send through the turns API
 *   - how many screenshots to take of the finished conversation
 *
 * Needs: pnpm install already done at the repo root, outbound network access
 * to the Spark model endpoint, and (for screenshots) a Chromium binary —
 * installed on first run via `npx playwright-core install chromium`.
 *
 * Only Node builtins are used, plus playwright-core resolved from
 * packages/frontend/node_modules at runtime.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'http://127.0.0.1:8790';
const UI = 'http://127.0.0.1:5173';
const MODEL_FQN = 'spark/gpt-oss-120b-derestricted';
const PROVIDER_MANIFEST = {
  type: 'custom',
  name: 'spark',
  base_url: 'https://spark-2516.tail0e1aa9.ts.net:8456/v1',
  models: [
    {
      model_id: 'gpt-oss-120b-derestricted',
      name: 'gpt-oss-120b-derestricted',
      properties: { context_length: 131072 },
    },
  ],
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error('FATAL:', msg);
  process.exit(1);
}

// ---------------------------------------------------------------- args ----
const scenarioName = (() => {
  const i = process.argv.indexOf('--scenario');
  const name = i >= 0 ? process.argv[i + 1] : '';
  if (!/^[a-z0-9-]{1,64}$/.test(name || '')) fail('usage: run-scenarios.mjs --scenario <name> (a-z, 0-9, dash)');
  return name;
})();

const scenarioPath = path.join(HERE, 'scenarios', `${scenarioName}.json`);
if (!existsSync(scenarioPath)) fail(`scenario not found: ${scenarioPath}`);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) fail('scenario has no turns');

const outDir = path.join(HERE, 'out', scenarioName);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- http -----
async function api(method, p, body, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${text.slice(0, 600)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------ preflight ----
function sparkReachable() {
  const url = `${PROVIDER_MANIFEST.base_url}/models`;
  for (const extra of [[], ['-k']]) {
    const r = spawnSync('curl', ['-sS', '-m', '20', ...extra, url], { encoding: 'utf8' });
    if (r.status === 0) {
      log(`spark reachable (${extra.includes('-k') ? 'insecure TLS' : 'strict TLS'})`);
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------- servers ---
let serverProc = null;

function killStale() {
  for (const pattern of ['tsx watch --env-file=.env src/main.ts', 'tsx --env-file=.env src/main.ts', 'vite']) {
    try {
      spawnSync('pkill', ['-f', pattern]);
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(url, label, timeoutMs, onTimeout) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        log(`${label} is up`);
        return;
      }
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      if (onTimeout) await onTimeout();
      fail(`${label} did not come up at ${url} within ${timeoutMs / 1000}s`);
    }
    await sleep(5000);
  }
}

/**
 * Diagnostic: print the tail of the backend server log. Called when the
 * backend boot probe times out so the failure output shows the actual
 * startup error instead of just "did not come up".
 */
async function dumpServerLogTail() {
  try {
    const fs = await import('node:fs');
    const logPath = path.join(outDir, 'server.log');
    if (!fs.existsSync(logPath)) {
      console.error('diagnostic: server.log not found at ' + logPath);
      return;
    }
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const tail = lines.slice(-80);
    console.error(`diagnostic: server.log tail (last ${tail.length} of ${lines.length} lines):`);
    for (const line of tail) console.error('  | ' + line.slice(0, 500));
  } catch (e) {
    console.error('diagnostic: failed to read server.log: ' + (e?.message ?? e));
  }
}

async function startServers() {
  killStale();
  await sleep(2000);
  // Scenario-scoped SQLite DB, reset fresh each run. The shared box DB
  // accumulates branch-specific migrations; Kysely fails closed at boot
  // when a recorded migration file is absent from the current branch.
  const fsMod = await import('node:fs');
  const dbPath = path.join(outDir, 'harness.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fsMod.unlinkSync(dbPath + suffix); } catch { /* fresh start */ }
  }
  log('starting harness (standalone:dev:no-watch) ...');
  const logPath = path.join(outDir, 'server.log');
  const logFd = (await import('node:fs')).openSync(logPath, 'a');
  serverProc = spawn('pnpm', ['standalone:dev:no-watch'], {
    cwd: ROOT,
    env: {
      ...process.env,
      STANDALONE: 'true',
      NODE_ENV: 'development',
      TRUEFORGE_API_KEY: 'trueforge-local-dev',
      PORT: '8790',
      SQLITE_PATH: dbPath,
      // Bind loopback IPv4 explicitly: the backend default HOST=localhost
      // resolves to ::1 on this host, which the 127.0.0.1 health poll below
      // can never reach. FRONTEND_PORT pins the vite dev server to the URL
      // the harness waits on.
      HOST: '127.0.0.1',
      FRONTEND_PORT: '5173',
      VITE_HOST: '127.0.0.1',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  serverProc.unref();
  log('server log:', logPath);
  await waitFor(`${API}/healthz`, 'backend', 420000, dumpServerLogTail);
  await waitFor(`${UI}/`, 'frontend', 240000);
}

function stopServers() {
  if (serverProc && serverProc.pid) {
    try {
      process.kill(-serverProc.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  killStale();
}

// ------------------------------------------------------------ scenario -----
async function ensureProvider() {
  log('registering spark provider ...');
  await api('PUT', '/api/v1/settings/model-providers', { manifest: PROVIDER_MANIFEST }, { timeoutMs: 60000 });
  log('provider ok');
}

async function ensurePersona() {
  if (!scenario.persona) return null;
  const wanted = scenario.persona.display_name;
  const list = await api('GET', '/api/v1/personas/');
  const rows = list?.personas ?? list ?? [];
  const found = Array.isArray(rows) ? rows.find((p) => p?.display_name === wanted || p?.persona?.display_name === wanted) : null;
  if (found) {
    const id = found.id ?? found.persona?.id;
    log(`persona "${wanted}" already exists (${id})`);
    return id;
  }
  log(`creating persona "${wanted}" ...`);
  const created = await api('POST', '/api/v1/personas/', { persona: scenario.persona }, { timeoutMs: 60000 });
  const id = created?.persona?.id ?? created?.id;
  if (!id) fail('persona create returned no id: ' + JSON.stringify(created).slice(0, 300));
  log(`persona created (${id})`);
  return id;
}

async function createSession() {
  const created = await api(
    'POST',
    '/api/v1/sessions/',
    { agent: { spec: { model: { name: MODEL_FQN } } } },
    { timeoutMs: 60000 },
  );
  const id = created?.session?.id ?? created?.id;
  if (!id) fail('session create returned no id: ' + JSON.stringify(created).slice(0, 300));
  log('session created:', id);
  return id;
}

function extractAssistantText(turn) {
  const output = turn?.turn?.state?.output ?? turn?.state?.output ?? [];
  const texts = [];
  if (Array.isArray(output)) {
    for (const ev of output) {
      const kind = ev?.type ?? '';
      if (/model\.message|assistant/.test(kind) && ev?.content) {
        const c = ev.content;
        if (typeof c === 'string') texts.push(c);
        else if (Array.isArray(c)) {
          for (const part of c) {
            if (typeof part === 'string') texts.push(part);
            else if (part && typeof part.text === 'string') texts.push(part.text);
          }
        }
      }
    }
  }
  return texts.join('\n\n');
}

async function runTurn(sessionId, content, index) {
  log(`--- turn ${index + 1}/${scenario.turns.length} ---`);
  log('user:', content.slice(0, 160).replace(/\n/g, ' '));
  const created = await api(
    'POST',
    `/api/v1/sessions/${sessionId}/turns`,
    { input: [{ type: 'user.message', content }], stream: false },
    { timeoutMs: 120000 },
  );
  const turnId = created?.turn?.id ?? created?.id;
  if (!turnId) fail('turn create returned no id: ' + JSON.stringify(created).slice(0, 300));
  const deadline = Date.now() + 600000;
  for (;;) {
    await sleep(5000);
    const t = await api('GET', `/api/v1/sessions/${sessionId}/turns/${turnId}`, undefined, { timeoutMs: 30000 });
    const st = t?.turn?.state?.status ?? t?.state?.status;
    if (st === 'done') {
      const text = extractAssistantText(t);
      log(`assistant (${text.length} chars):`, text.slice(0, 220).replace(/\n/g, ' '));
      return text;
    }
    if (st === 'failed' || st === 'error' || st === 'cancelled') {
      fail(`turn ended with status ${st}: ` + JSON.stringify(t).slice(0, 600));
    }
    if (Date.now() > deadline) fail('turn timed out after 600s');
    log('turn status:', st ?? 'unknown', '— waiting');
  }
}

// ----------------------------------------------------------- screenshots ---
function loadPlaywright() {
  const req = createRequire(path.join(ROOT, 'packages/frontend/package.json'));
  return req('playwright-core');
}

async function ensureChromium(pw) {
  try {
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
    log('chromium launchable');
    return;
  } catch (e) {
    log('chromium not launchable, installing ...', String(e && e.message ? e.message : e).slice(0, 200));
  }
  const r = spawnSync('npx', ['-y', 'playwright-core', 'install', 'chromium'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 900000,
  });
  if (r.status !== 0) fail('chromium install failed: ' + (r.stderr || r.stdout || '').slice(0, 600));
  log('chromium installed');
}

async function takeScreenshots(sessionId, lastText) {
  const pw = loadPlaywright();
  await ensureChromium(pw);
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const url = `${UI}/sessions/${sessionId}`;
  log('opening', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const needle = (lastText || '').slice(0, 60).trim();
  if (needle) {
    await page
      .waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout: 90000 })
      .catch(() => log('WARN: expected reply text not found in page; screenshotting anyway'));
  } else {
    await sleep(8000);
  }
  await sleep(2500);
  const shots = [];
  const shot1 = path.join(outDir, 'shot-1.png');
  await page.screenshot({ path: shot1, fullPage: true });
  shots.push(shot1);
  log('saved', shot1);
  if ((scenario.shots ?? 1) >= 2) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1200);
    const shot2 = path.join(outDir, 'shot-2.png');
    await page.screenshot({ path: shot2 });
    shots.push(shot2);
    log('saved', shot2);
  }
  await browser.close();
  return shots;
}

// ------------------------------------------------------------------ main ---
let lastText = '';
try {
  log(`scenario: ${scenarioName} (${scenario.turns.length} turns)`);
  if (!sparkReachable()) fail('spark model endpoint unreachable (strict and insecure TLS both failed)');
  await startServers();
  await ensureProvider();
  const personaId = await ensurePersona();
  const sessionId = await createSession();
  if (personaId) {
    await api('PUT', `/api/v1/sessions/${sessionId}/persona`, { persona_id: personaId });
    log('persona attached to session');
  }
  for (let i = 0; i < scenario.turns.length; i++) {
    lastText = await runTurn(sessionId, scenario.turns[i], i);
  }
  const shots = await takeScreenshots(sessionId, lastText);
  log(`RESULT session=${sessionId} turns=${scenario.turns.length}`);
  for (const s of shots) log('SCREENSHOT:', s);
} finally {
  stopServers();
}
log('done');
