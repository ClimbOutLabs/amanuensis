// Starts the Dockerfile's own CMD (the entrypoint, which runs supergateway around the real
// @ni-c/caldav-mcp once an account is saved) and checks the HTTP tool list. No CalDAV server is
// needed: tools/list never contacts one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_TIMEOUT_MS = 30_000;

// Must match the tool names in docker-compose.yml (CALDAV_ALLOW_TOOLS).
const CALENDAR_TOOLS = [
  'list_calendars',
  'list_events',
  'get_event',
  'search_events',
  'create_event',
  'update_event',
  'delete_event',
  'respond_to_event',
];

function freePort() {
  return new Promise((done, failed) => {
    const probe = createServer();
    probe.on('error', failed);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// The CMD from the Dockerfile must be the entrypoint this test starts.
function entrypointFromDockerfile() {
  const dockerfile = readFileSync(resolve(SIDECAR_ROOT, 'Dockerfile'), 'utf8');
  const cmdLine = dockerfile.split('\n').find(line => line.startsWith('CMD '));
  if (cmdLine === undefined) {
    throw new Error('Dockerfile has no CMD line');
  }
  return JSON.parse(cmdLine.slice('CMD '.length)).map(arg => arg.replaceAll('/app', SIDECAR_ROOT));
}

// The child gets only what the Compose service would give it, plus the account file it reads. No
// credentials are real.
function childEnv({ accountFile, port, agentPort }) {
  return {
    PATH: process.env.PATH ?? '',
    CALENDAR_ACCOUNT_FILE: accountFile,
    CALENDAR_ACCOUNT_PORT: String(agentPort),
    CALENDAR_ACCOUNT_SECRET: 'test-account-secret-0123456789abcdef0123',
    CALENDAR_MCP_HOST: '127.0.0.1',
    CALENDAR_MCP_PORT: String(port),
    CALDAV_ALLOW_TOOLS: CALENDAR_TOOLS.join(','),
    ELICITATION: 'false',
  };
}

function parseMessage(text) {
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(dataLine === undefined ? text : dataLine.slice('data: '.length));
}

const sleep = ms => new Promise(wake => setTimeout(wake, ms));

describe('calendar sidecar over HTTP', () => {
  let child;
  let mcpUrl;
  let folder;
  let stderr = '';

  async function rpc(method, params = {}) {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return parseMessage(await response.text());
  }

  before(async () => {
    const port = await freePort();
    const agentPort = await freePort();
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    folder = mkdtempSync(join(tmpdir(), 'calendar-sidecar-'));
    const accountFile = join(folder, '.env.calendar');
    writeFileSync(
      accountFile,
      'CALDAV_URL=https://203.0.113.10/dav/\nCALDAV_USERNAME=owner@example.invalid\nCALDAV_PASSWORD=test-password\nCALDAV_USER_EMAIL=owner@example.invalid\n',
      { mode: 0o600 },
    );
    const [command, ...args] = entrypointFromDockerfile();
    child = spawn(command, args, {
      cwd: SIDECAR_ROOT,
      env: childEnv({ accountFile, port, agentPort }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const reply = await rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'calendar-sidecar-test', version: '1' },
        });
        assert.equal(reply.result?.serverInfo?.name, 'caldav-mcp', stderr);
        return;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`calendar sidecar did not answer on ${mcpUrl}: ${stderr}`, { cause: error });
        }
        await sleep(500);
      }
    }
  });

  after(() => {
    child?.kill('SIGTERM');
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('offers exactly the eight calendar tools', async () => {
    const reply = await rpc('tools/list');
    const names = reply.result.tools.map(tool => tool.name);
    assert.deepEqual([...names].sort(), [...CALENDAR_TOOLS].sort());
  });

  it('refuses a tool that is not on the allow list', async () => {
    const reply = await rpc('tools/call', { name: 'delete_task', arguments: {} });
    assert.ok(reply.error !== undefined || reply.result?.isError === true, JSON.stringify(reply));
  });
});

async function listeningAt(url) {
  try {
    await fetch(url, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

const listening = port => listeningAt(`http://127.0.0.1:${port}/mcp`);

async function waitFor(check, what) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(300);
  }
}

describe('calendar sidecar follows the saved account', () => {
  let child;
  let folder;

  after(() => {
    child?.kill('SIGTERM');
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('offers no tools until an account is saved, and none again once it is removed', async () => {
    const port = await freePort();
    const agentPort = await freePort();
    folder = mkdtempSync(join(tmpdir(), 'calendar-sidecar-'));
    const accountFile = join(folder, '.env.calendar');
    const [command, ...args] = entrypointFromDockerfile();
    child = spawn(command, args, {
      cwd: SIDECAR_ROOT,
      env: childEnv({ accountFile, port, agentPort }),
      stdio: 'ignore',
    });
    await waitFor(() => listeningAt(`http://127.0.0.1:${agentPort}/account`), 'the account agent');
    assert.equal(await listening(port), false, 'no tool server without an account');

    writeFileSync(
      accountFile,
      'CALDAV_URL=https://203.0.113.10/dav/\nCALDAV_USERNAME=owner@example.invalid\nCALDAV_PASSWORD=test-password\nCALDAV_USER_EMAIL=owner@example.invalid\n',
      { mode: 0o600 },
    );
    await waitFor(() => listening(port), 'the tool server to start');

    rmSync(accountFile);
    await waitFor(async () => !(await listening(port)), 'the tool server to stop');
  });
});

describe('calendar sidecar without an account secret', () => {
  let child;
  let folder;

  after(() => {
    child?.kill('SIGTERM');
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('keeps the account port closed and says so in one line', async () => {
    const port = await freePort();
    const agentPort = await freePort();
    folder = mkdtempSync(join(tmpdir(), 'calendar-sidecar-'));
    const [command, ...args] = entrypointFromDockerfile();
    const withoutSecret = childEnv({ accountFile: join(folder, '.env.calendar'), port, agentPort });
    delete withoutSecret.CALENDAR_ACCOUNT_SECRET;
    let stderr = '';
    child = spawn(command, args, { cwd: SIDECAR_ROOT, env: withoutSecret, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    await waitFor(async () => stderr.includes('its port is closed'), 'the closed-port line');
    assert.equal(await listeningAt(`http://127.0.0.1:${agentPort}/account`), false);
  });
});
