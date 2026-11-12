#!/usr/bin/env node
// Starts the real Obsidian app with no screen, on a small made-up vault, with its Local REST API
// plugin turned on. Run by `pnpm run nightly:obsidian-notes:start` in the Obsidian notes workflow,
// after that workflow has installed Obsidian and downloaded the plugin.
//
// Obsidian keeps running after this script ends. The address and the key the notes test needs are
// written to GITHUB_ENV.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const { WebSocket } = globalThis;

const PLUGIN_ID = 'obsidian-local-rest-api';
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];
const DEBUG_PORT = 9222;
const NOTES_PORT = 27123;
const NOTES_ADDRESS = `http://127.0.0.1:${String(NOTES_PORT)}`;
const START_TIMEOUT_MS = 120_000;

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this from the Obsidian notes workflow, which sets it.`);
  }
  return value;
}

/** Calls `attempt` until it returns something, or stops with `what` once the time is up. */
async function waitFor({ what, attempt }) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const found = await attempt();
      if (found !== undefined) {
        return found;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`${what} did not happen in time. Read the Obsidian log printed below.`, { cause: lastError });
}

function writeVault({ vaultDir, pluginSourceDir }) {
  const pluginDir = path.join(vaultDir, '.obsidian', 'plugins', PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });
  for (const file of PLUGIN_FILES) {
    copyFileSync(path.join(pluginSourceDir, file), path.join(pluginDir, file));
  }
  writeFileSync(path.join(vaultDir, '.obsidian', 'community-plugins.json'), JSON.stringify([PLUGIN_ID]));
  writeFileSync(path.join(vaultDir, 'Garden plan.md'), 'Plant the tomatoes after the last frost.\n');
  writeFileSync(path.join(vaultDir, 'Reading list.md'), 'A book about lighthouses.\n');
}

/** Tells Obsidian which vault to open, the way its own vault picker records it. */
function writeObsidianConfig({ userDataDir, vaultDir }) {
  mkdirSync(userDataDir, { recursive: true });
  const vaultId = randomBytes(8).toString('hex');
  writeFileSync(
    path.join(userDataDir, 'obsidian.json'),
    JSON.stringify({ vaults: { [vaultId]: { path: vaultDir, ts: Date.now(), open: true } } }),
  );
}

/** Runs `expression` inside the Obsidian window and returns what it resolves to. */
async function runInWindow({ socketUrl, expression }) {
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Obsidian window.')), {
      once: true,
    });
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true });
      socket.addEventListener('close', () => reject(new Error('The Obsidian window closed.')), { once: true });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    const problem = reply.error ?? reply.result?.exceptionDetails;
    if (problem !== undefined) {
      throw new Error(`Obsidian could not run the setup step: ${JSON.stringify(problem)}`);
    }
    return reply.result.result.value;
  } finally {
    socket.close();
  }
}

// Turns community plugins on, turns the plugin on, and turns on its plain-http server, the same
// three switches a person flips in Obsidian's settings. Returns the plugin's key and versions.
const TURN_PLUGIN_ON = `(async () => {
  const id = ${JSON.stringify(PLUGIN_ID)};
  for (let i = 0; i < 300 && !(window.app && window.app.plugins); i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await app.plugins.setEnable(true);
  await app.plugins.enablePluginAndSave(id);
  const plugin = app.plugins.plugins[id];
  if (!plugin) {
    throw new Error('the plugin did not load');
  }
  if (!plugin.settings.enableInsecureServer) {
    plugin.settings.enableInsecureServer = true;
    await plugin.saveSettings();
    plugin.refreshServerState();
  }
  return {
    apiKey: plugin.settings.apiKey,
    pluginVersion: plugin.manifest.version,
    userAgent: navigator.userAgent,
  };
})()`;

async function main() {
  const obsidianBin = requiredEnv('OBSIDIAN_BIN');
  const pluginSourceDir = requiredEnv('OBSIDIAN_PLUGIN_DIR');
  const workDir = requiredEnv('OBSIDIAN_WORK_DIR');
  const githubEnv = requiredEnv('GITHUB_ENV');

  const vaultDir = path.join(workDir, 'vault');
  const userDataDir = path.join(workDir, 'user-data');
  const logPath = path.join(workDir, 'obsidian.log');
  writeVault({ vaultDir, pluginSourceDir });
  writeObsidianConfig({ userDataDir, vaultDir });

  const log = openSync(logPath, 'a');
  const obsidian = spawn(
    'xvfb-run',
    [
      '--auto-servernum',
      obsidianBin,
      '--no-sandbox',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${String(DEBUG_PORT)}`,
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  obsidian.unref();

  try {
    const socketUrl = await waitFor({
      what: 'Obsidian opening the vault',
      attempt: async () => {
        const windows = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`)).json();
        return windows.find(window => window.type === 'page' && String(window.url).includes('index.html'))
          ?.webSocketDebuggerUrl;
      },
    });
    const { apiKey, pluginVersion, userAgent } = await runInWindow({ socketUrl, expression: TURN_PLUGIN_ON });
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new Error('The plugin gave no key. Check that the plugin still keeps its key in its settings.');
    }
    await waitFor({
      what: 'The plugin answering on its address',
      attempt: async () => ((await fetch(`${NOTES_ADDRESS}/`)).ok ? true : undefined),
    });
    console.log(`::add-mask::${apiKey}`);
    appendFileSync(githubEnv, `OBSIDIAN_MCP_URL=${NOTES_ADDRESS}/mcp/\nOBSIDIAN_API_KEY=${apiKey}\n`);
    console.log(`Obsidian is running. Plugin ${String(pluginVersion)}. ${String(userAgent)}`);
  } catch (error) {
    console.error(readFileSync(logPath, 'utf8').split('\n').slice(-80).join('\n'));
    throw error;
  }
}

await main();
