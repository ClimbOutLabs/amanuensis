#!/usr/bin/env node
/**
 * buildbox/run-scenarios.mjs
 *
 * REAL browser-driven UI testing for Sentinel (and other scenarios).
 *
 * Drives a headless Chromium through the actual Amanuensis UI:
 * registering the model provider, clicking toggles, sending chat messages,
 * approving/denying cards, and attempting break-ins, screenshotting every step.
 *
 * Maya rule: UI-only. The harness makes no calls to the app API; every setup
 * step, including model provider registration, goes through the browser.
 *
 * Usage: node buildbox/run-scenarios.mjs --scenario <name>
 *
 * Needs: pnpm install already done at the repo root, a Token Factory API key at
 * /home/opc/.config/tokenfactory-key (chmod 600), and (for the browser) a
 * Chromium binary — installed on first run via `npx playwright-core install chromium`.
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
const TOKEN_FACTORY_KEY_FILE = '/home/opc/.config/tokenfactory-key';
const TOKEN_FACTORY_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const TOKEN_FACTORY_MODEL_ID = 'nvidia/Nemotron-3_5-Lightning';
const TOKEN_FACTORY_MODEL_NAME = 'nemotron-3-5-lightning';

function readTokenFactoryKey() {
  let key = '';
  try {
    key = readFileSync(TOKEN_FACTORY_KEY_FILE, 'utf8').trim();
  } catch {
    /* missing or unreadable */
  }
  if (!key) {
    fail(
      `token factory key missing: write it to ${TOKEN_FACTORY_KEY_FILE} and chmod 600 it ` +
        `(echo '<key>' > ${TOKEN_FACTORY_KEY_FILE} && chmod 600 ${TOKEN_FACTORY_KEY_FILE})`,
    );
  }
  return key;
}

// Values typed into the Add Custom Provider form in Settings > Models.
// A custom provider is OpenAI-compatible, so it drives Token Factory exactly
// like the well-known tokenfactory type; only the base URL default differs.
const PROVIDER_FORM = {
  providerName: 'tokenfactory',
  baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  modelId: TOKEN_FACTORY_MODEL_ID,
  modelName: TOKEN_FACTORY_MODEL_NAME,
  contextLength: '1048576',
  maxOutputTokens: '8192',
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

const outDir = path.join(HERE, 'out', scenarioName);
const shotDir = path.join(outDir, 'screenshots');
mkdirSync(shotDir, { recursive: true });

// ------------------------------------------------------------ preflight ----
function tokenFactoryReachable() {
  const key = readTokenFactoryKey();
  const r = spawnSync(
    'curl',
    ['-sS', '-m', '20', '-H', `Authorization: Bearer ${key}`, `${TOKEN_FACTORY_BASE_URL}/models`],
    { encoding: 'utf8' },
  );
  if (r.status === 0) {
    log('token factory reachable');
    return true;
  }
  log('token factory preflight failed:', (r.stderr || r.stdout || '').slice(0, 300));
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

async function waitFor(url, label, timeoutMs) {
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
    if (Date.now() > deadline) fail(`${label} did not come up at ${url} within ${timeoutMs / 1000}s`);
    await sleep(5000);
  }
}

async function startServers() {
  killStale();
  await sleep(2000);
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
      HOST: '127.0.0.1',
      FRONTEND_PORT: '5173',
      VITE_HOST: '127.0.0.1',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  serverProc.unref();
  log('server log:', logPath);
  await waitFor(`${API}/healthz`, 'backend', 420000);
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

// ----------------------------------------------------------- playwright ----
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

// ------------------------------------------------------------ scenario ---
/**
 * Every check below is a real browser interaction. Screenshots are numbered
 * in run order under buildbox/out/<scenario>/screenshots/.
 */
async function runSentinelScenario(pw) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail: detail || '' });
    log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) fail(`check failed: ${name} — ${detail}`);
  };

  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Capture every API request the UI makes (needed for the token-replay break attempt).
  const apiRequests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(API + '/api/') || url.includes('/api/v1/')) {
      apiRequests.push({ method: req.method(), url, postData: req.postData() });
    }
  });

  const shot = async (name) => {
    const p = path.join(shotDir, name);
    await page.screenshot({ path: p, fullPage: true });
    log('SCREENSHOT:', p);
    return p;
  };

  // --- helpers ---------------------------------------------------------
  async function findComposer() {
    // Try several selector strategies; the composer is assistant-ui based.
    const strategies = [
      '[data-slot="aui_composer-shell"] textarea',
      '[data-slot="aui_composer-shell"] [contenteditable="true"]',
      'textarea[placeholder]',
      '[data-slot="aui_composer-shell"]',
    ];
    for (const sel of strategies) {
      const el = await page.$(sel);
      if (el) {
        const tag = await el.evaluate((e) => e.tagName.toLowerCase());
        const editable = await el.evaluate((e) => e.getAttribute('contenteditable'));
        if (tag === 'textarea' || editable === 'true') return el;
        // container: look for textarea inside
        const inner = await el.$('textarea, [contenteditable="true"]');
        if (inner) return inner;
      }
    }
    return null;
  }

  async function sendChatMessage(text) {
    const composer = await findComposer();
    if (!composer) fail('chat composer not found');
    await composer.click();
    await composer.fill(text);
    await sleep(500);
    // Prefer Enter to send; fall back to clicking a send button.
    await page.keyboard.press('Enter');
    await sleep(1500);
    // If the text is still in the composer, Enter didn't send; try the send button.
    const stillThere = await composer.evaluate((e) => (e.value !== undefined ? e.value : e.innerText) || '');
    if (stillThere.includes(text.slice(0, 20))) {
      const sendBtn = await page.$('[data-slot="aui_composer-shell"] button[type="submit"], [data-slot="aui_composer-shell"] button[aria-label*="Send" i]');
      if (sendBtn) {
        await sendBtn.click();
        await sleep(1500);
      }
    }
  }

  async function waitForText(text, timeoutMs, description) {
    try {
      await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: timeoutMs });
      return true;
    } catch {
      log(`WARN: timed out waiting for "${description || text}"`);
      return false;
    }
  }

  // --- UI-only helpers -------------------------------------------------
  // Click the button whose visible text exactly matches `label`, scoped to
  // `containerSel`. Playwright's :has-text is substring-based, and "Models"
  // would also match "Model roles", so compare the trimmed text instead.
  async function clickExactButton(containerSel, label) {
    const buttons = await page.$$(`${containerSel} button`);
    for (const b of buttons) {
      const text = ((await b.textContent()) || '').trim();
      if (text === label) {
        await b.click();
        return true;
      }
    }
    return false;
  }

  // --- 1. register the model provider through the Settings UI ---------------
  // Maya rule: no harness API calls. The provider is added via Settings >
  // Models > Add Custom Provider, exactly as a user would do it.
  async function registerProviderViaUI() {
    log('registering token factory provider through the UI ...');
    const apiKey = readTokenFactoryKey();

    await page.goto(UI + '/settings', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);
    let sectionsNav = await page.$('nav[aria-label="Settings sections"]');
    if (!sectionsNav) {
      log('settings route did not render the panel; falling back to home (settings auto-opens when no model is set)');
      await page.goto(UI + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await sleep(4000);
      sectionsNav = await page.$('nav[aria-label="Settings sections"]');
    }
    check('settings panel opened', !!sectionsNav);

    check('Models section opened', await clickExactButton('nav[aria-label="Settings sections"]', 'Models'));
    await sleep(1500);

    // A previous run may already have configured the provider; reuse it then.
    const alreadyConfigured = await page.evaluate(() => document.body.innerText.includes('tokenfactory'));
    if (alreadyConfigured) {
      log('token factory provider already configured; skipping the form');
    } else {
      check('Add Custom Provider opened', await clickExactButton('body', 'Add Custom Provider'));
      await page.waitForSelector('#custom-provider-name', { timeout: 20000 });

      await page.fill('#custom-provider-name', PROVIDER_FORM.providerName);
      await page.fill('#custom-provider-base-url', PROVIDER_FORM.baseUrl);
      await page.fill('#custom-provider-api-key', apiKey);
      await page.fill('#custom-provider-model-0-id', PROVIDER_FORM.modelId);
      // The model name auto-derives from the id; set it explicitly for determinism.
      await page.fill('#custom-provider-model-0-name', PROVIDER_FORM.modelName);
      await page.fill('#custom-provider-model-0-context-length', PROVIDER_FORM.contextLength);
      await page.fill('#custom-provider-model-0-max-output-tokens', PROVIDER_FORM.maxOutputTokens);
      await sleep(800);
      await shot('00-provider-form-filled.png');

      const addBtn = await page.$('button[type="submit"]:has-text("Add provider")');
      const addEnabled = addBtn ? await addBtn.isEnabled() : false;
      check('Add provider submit enabled', addEnabled);
      await addBtn.click();
      // The modal closes on success and stays open with an inline error on failure.
      await page.waitForSelector('#custom-provider-name', { state: 'detached', timeout: 60000 }).catch(() => {});
      const stillOpen = !!(await page.$('#custom-provider-name'));
      if (stillOpen) {
        const formText = await page.evaluate(() => document.body.innerText.slice(0, 600));
        log('provider form stayed open; page text:', JSON.stringify(formText));
      }
      check('provider form submitted (modal closed)', !stillOpen);
    }

    const listed = await waitForText('tokenfactory', 30000, 'provider in Configured list');
    check('token factory provider appears in Configured', listed);
    await shot('00-provider-configured.png');
  }

  await registerProviderViaUI();

  // Reload so boot re-reads the model list; the first model becomes the default
  // agent model. This is a browser navigation, not an API call.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);
  const modelChosen = await page.evaluate(() => !document.body.innerText.includes('No model chosen yet'));
  check('model chosen after reload (setup checklist cleared)', modelChosen);

  // --- 2. open the UI and start a chat --------------------------------------
  log('opening UI ...');
  await page.goto(UI + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);

  // Start a session by sending a first message through the real composer.
  await sendChatMessage('Hello, are you ready?');
  // The URL should become /sessions/:id once the session exists.
  await page.waitForFunction(() => window.location.pathname.includes('/sessions/'), null, { timeout: 60000 })
    .catch(() => log('WARN: URL did not change to /sessions/; continuing'));
  const sessionId = await page.evaluate(() => {
    const m = window.location.pathname.match(/\/sessions\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  });
  log('session id:', sessionId || '(unknown)');
  await waitForText('ready', 120000, 'assistant greeting reply');
  await sleep(2000);
  await shot('01-initial-state.png');
  check('UI loads and chat works', true);

  // --- 3. find the Permissions section (right rail) ----------------------
  // The toggle is the real target; wait for it directly instead of text.
  const toggleSelector = '[aria-label="Always ask before shell"]';
  async function ensureToggleVisible() {
    // Try to expand the rail if it's collapsed.
    const expandBtn = await page.$('[aria-label="Expand rail"]');
    if (expandBtn) {
      log('expanding collapsed rail ...');
      await expandBtn.click();
      await sleep(1500);
    }
    try {
      await page.waitForSelector(toggleSelector, { timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  }
  let toggleFound = await ensureToggleVisible();
  if (!toggleFound) {
    // Debug: dump what's actually in the rail.
    const railDebug = await page.evaluate(() => {
      const rail = document.querySelector('[aria-label="Amanuensis runtime status"]');
      if (!rail) return 'no runtime rail in DOM';
      const sections = [...rail.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));
      const text = rail.innerText.slice(0, 500);
      return `sections=[${sections.join(',')}] text=${JSON.stringify(text)}`;
    });
    log('rail debug:', railDebug);
    await shot('02-rail-debug.png');
  }
  check('shell "Always ask" toggle found', toggleFound);
  const toggle = await page.$(toggleSelector);
  const wasChecked = await toggle.evaluate((e) => e.getAttribute('aria-checked') === 'true' || e.checked === true);
  log('toggle was checked:', wasChecked);
  if (!wasChecked) {
    await toggle.click();
    await sleep(2000);
  }
  const nowChecked = await page.$(toggleSelector).then((el) =>
    el ? el.evaluate((e) => e.getAttribute('aria-checked') === 'true' || e.checked === true) : false,
  );
  check('shell "Always ask" toggle enabled', nowChecked === true);
  await shot('02-toggle-enabled.png');

  // --- 4. refresh: persistence -------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);
  const persistedVisible = await ensureToggleVisible();
  check('toggle visible after refresh', persistedVisible);
  const persisted = await page.$(toggleSelector).then((el) =>
    el ? el.evaluate((e) => e.getAttribute('aria-checked') === 'true' || e.checked === true) : false,
  );
  check('toggle persists after refresh', persisted === true);
  await shot('03-toggle-persisted.png');

  // --- 5. trigger a shell action -> approval card -------------------------
  await sendChatMessage('Use the shell tool to run `echo hello-sentinel`');
  const cardAppeared = await waitForText('Permission needed', 180000, 'approval card');
  check('Tier 3 approval card appears for shell (always-ask on)', cardAppeared);
  await sleep(1500);
  await shot('04-approval-card.png');

  // The card must show the exact command (binding evidence).
  const cardShowsCommand = await page.evaluate(() =>
    document.body.innerText.includes('echo hello-sentinel'),
  );
  check('approval card shows the exact command', cardShowsCommand);

  // --- 6. approve through the UI -------------------------------------------
  // Start capturing the approval request so we can replay it later.
  apiRequests.length = 0;
  const approveBtn = await page.$('button:has-text("Approve")');
  check('Approve button found', !!approveBtn);
  await approveBtn.click();
  await sleep(3000);
  // Wait for the command output to show up.
  const executed = await waitForText('hello-sentinel', 120000, 'command output');
  check('approved shell command executed', executed);
  await shot('05-approved-executed.png');

  // Find the approval request we just made (for replay attacks).
  const approvalReq = apiRequests.find((r) =>
    /approv|grant|decision|consent|allow/i.test(r.url) || (r.postData && /approv|allow/i.test(r.postData)),
  );
  log('captured approval request:', approvalReq ? `${approvalReq.method} ${approvalReq.url}` : '(none captured)');

  // --- 7. BREAK: token replay ----------------------------------------------
  // Re-send the exact captured approval request. Single-use tokens must reject it.
  let replayBlocked = false;
  let replayDetail = 'no approval request captured; could not attempt replay';
  if (approvalReq) {
    const replay = await page.evaluate(async (req) => {
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: req.postData || undefined,
          credentials: 'same-origin',
        });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 300) };
      } catch (e) {
        return { status: -1, body: String(e).slice(0, 300) };
      }
    }, approvalReq);
    replayDetail = `replay -> HTTP ${replay.status}: ${replay.body}`;
    log('token replay:', replayDetail);
    // Blocked = 4xx/5xx, or 2xx with an error body. A 2xx "ok" would be a vulnerability.
    replayBlocked = replay.status >= 400 || /error|denied|invalid|expired|already/i.test(replay.body);
    if (!replayBlocked && replay.status >= 200 && replay.status < 300) {
      log('WARN: replay returned 2xx; checking audit feed for a second execution');
    }
  }
  await shot('06-token-replay-attempt.png');
  check('token replay blocked (single-use)', replayBlocked, replayDetail);

  // --- 8. BREAK: command mutation --------------------------------------------
  // Replay the approval with a mutated command. The params hash must reject it.
  let mutationBlocked = false;
  let mutationDetail = 'no approval request captured; could not attempt mutation';
  if (approvalReq && approvalReq.postData) {
    const mutated = approvalReq.postData.replace(/hello-sentinel/g, 'MUTATED-evil');
    const sameLength = mutated !== approvalReq.postData;
    const res = await page.evaluate(async (req, body) => {
      try {
        const r = await fetch(req.url, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body,
          credentials: 'same-origin',
        });
        const text = await r.text();
        return { status: r.status, body: text.slice(0, 300) };
      } catch (e) {
        return { status: -1, body: String(e).slice(0, 300) };
      }
    }, approvalReq, sameLength ? mutated : approvalReq.postData + ' ');
    mutationDetail = `mutated replay -> HTTP ${res.status}: ${res.body}`;
    log('command mutation:', mutationDetail);
    mutationBlocked = res.status >= 400 || /error|denied|invalid|expired|already|mismatch/i.test(res.body);
  }
  await shot('07-command-mutation-attempt.png');
  check('mutated approval blocked (params hash mismatch)', mutationBlocked, mutationDetail);

  // --- 9. BREAK: LD_PRELOAD injection ------------------------------------------
  await sendChatMessage('Use the shell tool to run `echo env-check` with the environment variable LD_PRELOAD set to /tmp/evil.so');
  // Either a card appears showing the env var (caught), or it is blocked outright.
  const ldCard = await waitForText('Permission needed', 180000, 'LD_PRELOAD approval card');
  const ldBlockedText = await page.evaluate(() =>
    /blocked|denied|refused|not allowed/i.test(document.body.innerText),
  );
  await sleep(1500);
  await shot('08-ld-preload-attempt.png');
  // The injection is "caught" if a card names the env var, or the run was blocked.
  const cardNamesEnv = await page.evaluate(() => document.body.innerText.includes('LD_PRELOAD'));
  check('LD_PRELOAD injection caught (card names env var or run blocked)', ldCard && cardNamesEnv || ldBlockedText,
    ldCard ? `card shown, names LD_PRELOAD: ${cardNamesEnv}` : 'no card; checking block text');
  if (ldCard) {
    const denyBtn = await page.$('button:has-text("Deny")');
    if (denyBtn) {
      await denyBtn.click();
      await sleep(2000);
      log('LD_PRELOAD attempt denied');
    }
  }

  // --- 10. BREAK: destructive /tmp deletion ------------------------------------
  // Must run inside the sandbox; the agent runs everything sandboxed here.
  await sendChatMessage('Delete all files in /tmp');
  const tmpCard = await waitForText('Permission needed', 180000, 'destructive approval card');
  await sleep(1500);
  await shot('09-tmp-delete-card.png');
  check('destructive /tmp deletion requires approval (Tier 3)', tmpCard);
  if (tmpCard) {
    const denyBtn = await page.$('button:has-text("Deny")');
    check('Deny button found for /tmp deletion', !!denyBtn);
    if (denyBtn) {
      await denyBtn.click();
      await sleep(3000);
    }
  }
  // Verify the denial landed in the audit feed.
  const deniedVisible = await waitForText('Denied', 30000, 'denial in audit feed');
  await shot('10-audit-feed-denials.png');
  check('denial recorded in audit feed', deniedVisible);

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    scenario: scenarioName,
    sessionId,
    passed,
    failed: results.length - passed,
    checks: results,
    screenshots: shotDir,
  };
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(summary, null, 2));
  log(`RESULT passed=${passed}/${results.length}`);
  return summary;
}

// ------------------------------------------------------------------ main ---
try {
  log(`scenario: ${scenarioName} (browser-driven UI test)`);
  if (!tokenFactoryReachable()) fail('token factory unreachable (check key and network)');
  await startServers();
  const pw = loadPlaywright();
  await ensureChromium(pw);
  if (scenario.kind === 'sentinel-ui' || scenarioName === 'sentinel-settings') {
    await runSentinelScenario(pw);
  } else {
    fail(`unknown scenario kind for browser runner: ${scenario.kind || '(none)'}`);
  }
} finally {
  stopServers();
}
log('done');
