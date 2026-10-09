#!/usr/bin/env node
/**
 * buildbox/run-scenarios.mjs
 *
 * Drives one scripted assistant scenario against a local standalone Amanuensis
 * harness backed by an OpenAI-compatible model endpoint, then captures UI
 * screenshots.
 *
 * Usage: SCENARIO_MODEL_BASE_URL=https://host/v1 node buildbox/run-scenarios.mjs --scenario <name>
 *
 * Env:
 *   SCENARIO_MODEL_BASE_URL  required; base URL of the endpoint, including /v1
 *   SCENARIO_MODEL_API_KEY   optional; bearer key for the endpoint
 *
 * The scenario file lives at buildbox/scenarios/<name>.json and describes:
 *   - an optional persona to create and attach to the session
 *   - a list of user turns to send through the turns API
 *   - how many screenshots to take of the finished conversation
 *
 * Needs: pnpm install already done at the repo root, outbound network access
 * to the model endpoint, and (for screenshots) a Chromium binary,
 * installed on first run via `npx playwright-core install chromium`.
 *
 * Only Node builtins are used, plus playwright-core resolved from
 * packages/frontend/node_modules at runtime.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'http://127.0.0.1:8790';
const UI = 'http://127.0.0.1:5173';
let MODEL_FQN = ''; // resolved from the endpoint's /models at startup (see resolveModelId)
const MODEL_BASE_URL = process.env.SCENARIO_MODEL_BASE_URL?.replace(/\/+$/, '');
if (!MODEL_BASE_URL) {
  console.error('FATAL: SCENARIO_MODEL_BASE_URL is required (e.g. https://host:8000/v1)');
  process.exit(1);
}
const MODEL_API_KEY = process.env.SCENARIO_MODEL_API_KEY || '';
const PROVIDER_NAME = 'scenario-model';
const PROVIDER_MANIFEST = {
  type: 'custom',
  name: PROVIDER_NAME,
  base_url: MODEL_BASE_URL,
  ...(MODEL_API_KEY ? { auth: { api_key: MODEL_API_KEY } } : {}),
  models: [
    {
      model_id: 'gpt-oss-120b-derestricted',
      name: 'gpt-oss-120b-derestricted',
      properties: { context_length: 131072 },
    },
  ],
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const MODEL_HEADERS = MODEL_API_KEY ? { authorization: `Bearer ${MODEL_API_KEY}` } : {};

// GET <base>/models. The insecure variant disables TLS verification for the
// call only, for endpoints behind self-signed certificates.
async function fetchModels({ insecure }) {
  const url = `${PROVIDER_MANIFEST.base_url}/models`;
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const res = await fetch(url, { headers: MODEL_HEADERS, signal: AbortSignal.timeout(20000) });
    const body = (await res.text()).trim();
    return res.ok ? { ok: true, body } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 200) };
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

async function modelEndpointReachable() {
  for (const insecure of [false, true]) {
    if ((await fetchModels({ insecure })).ok) {
      log(`model endpoint reachable (${insecure ? 'insecure TLS' : 'strict TLS'})`);
      return true;
    }
  }
  return false;
}

// The endpoint serves exactly one model; resolve its id at runtime instead of
// hardcoding it, since a fixed name goes stale whenever the served model changes.
const MODEL_ID_CACHE = path.join(process.env.HOME || '/tmp', '.buildbox-runner', 'scenario-model-id');

async function resolveModelId() {
  const url = `${PROVIDER_MANIFEST.base_url}/models`;
  // The models endpoint intermittently returns empty bodies (HTTP 200 with a
  // zero-length response); bad windows have lasted 30s+, so retry patiently
  // before giving up.
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const insecure of [false, true]) {
      const mode = insecure ? 'insecure' : 'strict';
      const r = await fetchModels({ insecure });
      if (!r.ok) {
        log(`WARN: ${url} request failed (${mode}): ${r.error}`);
        continue;
      }
      const out = r.body;
      try {
        const id = JSON.parse(out)?.data?.[0]?.id;
        if (typeof id === 'string' && id.length > 0) {
          try {
            mkdirSync(path.dirname(MODEL_ID_CACHE), { recursive: true });
            writeFileSync(MODEL_ID_CACHE, id + '\n');
          } catch {
            /* cache is best-effort */
          }
          return id;
        }
        log(`WARN: ${url} (${mode}) returned no usable model id; body head: ${out.slice(0, 300)}`);
      } catch (e) {
        log(`WARN: ${url} (${mode}) returned unparseable body (${e.message}); body head: ${out.slice(0, 300)}`);
      }
    }
    if (attempt < maxAttempts) {
      log(`WARN: retrying ${url} in 30s (attempt ${attempt}/${maxAttempts}) ...`);
      await sleep(30000);
    }
  }
  // Last resort: reuse the most recently resolved id. A brain swap during an
  // endpoint outage would make this stale (the turn then 404s, exactly as the
  // old hardcoded name did), but that is rarer than the endpoint flake.
  try {
    const cached = readFileSync(MODEL_ID_CACHE, 'utf8').trim();
    if (cached) {
      log(`WARN: using cached model id '${cached}' after ${maxAttempts} failed resolution attempts`);
      return cached;
    }
  } catch {
    /* no cache yet */
  }
  fail('could not resolve the served model id from the /models endpoint');
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
    try {
      fsMod.unlinkSync(dbPath + suffix);
    } catch {
      /* fresh start */
    }
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
  log('registering scenario-model provider ...');
  await api('PUT', '/api/v1/settings/model-providers', { manifest: PROVIDER_MANIFEST }, { timeoutMs: 60000 });
  log('provider ok');
}

async function ensurePersona() {
  if (!scenario.persona) return null;
  const wanted = scenario.persona.display_name;
  const list = await api('GET', '/api/v1/personas');
  const rows = list?.data ?? list?.personas ?? list ?? [];
  const found = Array.isArray(rows)
    ? rows.find(p => p?.display_name === wanted || p?.persona?.display_name === wanted)
    : null;
  if (found) {
    const id = found?.data?.id ?? found?.id ?? found?.persona?.id;
    log(`persona "${wanted}" already exists (${id})`);
    return id;
  }
  log(`creating persona "${wanted}" ...`);
  const created = await api('POST', '/api/v1/personas', { persona: scenario.persona }, { timeoutMs: 60000 });
  const id = created?.data?.id ?? created?.persona?.id ?? created?.id;
  if (!id) fail('persona create returned no id: ' + JSON.stringify(created).slice(0, 300));
  log(`persona created (${id})`);
  return id;
}

async function createSession() {
  const created = await api(
    'POST',
    '/api/v1/sessions',
    { agent: { spec: { model: { name: MODEL_FQN } } } },
    { timeoutMs: 60000 },
  );
  const id = created?.data?.id ?? created?.session?.id ?? created?.id;
  if (!id) fail('session create returned no id: ' + JSON.stringify(created).slice(0, 300));
  log('session created:', id);
  return id;
}

function extractAssistantText(turn) {
  const output = turn?.data?.state?.output ?? turn?.turn?.state?.output ?? turn?.state?.output ?? [];
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

async function runTurn(sessionId, turn, index) {
  const content = typeof turn === 'string' ? turn : (turn.user ?? turn.content ?? JSON.stringify(turn));
  log(`--- turn ${index + 1}/${scenario.turns.length} ---`);
  log('user:', content.slice(0, 160).replace(/\n/g, ' '));
  const created = await api(
    'POST',
    `/api/v1/sessions/${sessionId}/turns`,
    { input: [{ type: 'user.message', content }], stream: false },
    { timeoutMs: 120000 },
  );
  const turnId = created?.data?.id ?? created?.turn?.id ?? created?.id;
  if (!turnId) fail('turn create returned no id: ' + JSON.stringify(created).slice(0, 300));
  const deadline = Date.now() + 600000;
  for (;;) {
    await sleep(5000);
    const t = await api('GET', `/api/v1/sessions/${sessionId}/turns/${turnId}`, undefined, { timeoutMs: 30000 });
    const st = t?.data?.state?.status ?? t?.turn?.state?.status ?? t?.state?.status;
    if (st === 'done') {
      const text = extractAssistantText(t);
      log(`assistant (${text.length} chars):`, text.slice(0, 220).replace(/\n/g, ' '));
      return text;
    }
    if (st === 'failed' || st === 'error' || st === 'cancelled') {
      // The turn-facing message is often empty/generic; the backend stack
      // trace in server.log carries the real mechanism.
      await dumpServerLogTail();
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
  // Install the browser with the same playwright-core copy the harness
  // launches with. `npx -y playwright-core` fetches the latest release, whose
  // browser build numbers can differ from the pinned copy in
  // packages/frontend, leaving the expected executable missing after a
  // "successful" install.
  const pwPkgDir = path.dirname(
    createRequire(path.join(ROOT, 'packages/frontend/package.json')).resolve('playwright-core/package.json'),
  );
  const r = spawnSync(process.execPath, [path.join(pwPkgDir, 'cli.js'), 'install', 'chromium'], {
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
      .waitForFunction(n => document.body.innerText.includes(n), needle, { timeout: 90000 })
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

/**
 * The served id is provider-shaped (e.g. `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4`)
 * but the manifest's `name` must satisfy NameSchema (2-64 lowercase chars, leading
 * letter, trailing alphanumeric, hyphens only), and the agent spec addresses the
 * model as `provider_name/model_name`. Slugify for `name`/FQN; `model_id` keeps the
 * exact upstream id the provider API needs.
 */
function slugifyModelName(id) {
  let slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!/^[a-z]/.test(slug)) slug = `m-${slug}`.replace(/-+$/, '');
  if (slug.length < 2) slug = 'model';
  return slug;
}

try {
  log(`scenario: ${scenarioName} (${scenario.turns.length} turns)`);
  if (!(await modelEndpointReachable())) fail('model endpoint unreachable (strict and insecure TLS both failed)');
  const servedModelId = await resolveModelId();
  const servedModelName = slugifyModelName(servedModelId);
  MODEL_FQN = `${PROVIDER_NAME}/${servedModelName}`;
  PROVIDER_MANIFEST.models[0].model_id = servedModelId;
  PROVIDER_MANIFEST.models[0].name = servedModelName;
  log('using model:', servedModelId, `(as ${servedModelName})`);
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
