// Starts the Dockerfile's own CMD (supergateway around the real @ni-c/caldav-mcp) and
// checks the HTTP tool list. No CalDAV server is needed: tools/list never contacts one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
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

// The Dockerfile's CMD, with /app mapped to this folder, a free port and loopback only.
function serverCommand(port) {
  const dockerfile = readFileSync(resolve(SIDECAR_ROOT, 'Dockerfile'), 'utf8');
  const cmdLine = dockerfile.split('\n').find(line => line.startsWith('CMD '));
  if (cmdLine === undefined) {
    throw new Error('Dockerfile has no CMD line');
  }
  const argv = JSON.parse(cmdLine.slice('CMD '.length)).map(arg => arg.replaceAll('/app', SIDECAR_ROOT));
  const withValue = (flag, value) => {
    const index = argv.indexOf(flag);
    if (index === -1) {
      throw new Error(`Dockerfile CMD has no ${flag}`);
    }
    argv[index + 1] = value;
  };
  withValue('--port', String(port));
  withValue('--host', '127.0.0.1');
  return argv;
}

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

// The child gets only what the Compose service would give it; no credentials are real.
function childEnv() {
  return {
    PATH: process.env.PATH ?? '',
    CALDAV_URL: 'http://127.0.0.1:9/',
    CALDAV_USERNAME: 'test-user',
    CALDAV_PASSWORD: 'test-password',
    CALDAV_USER_EMAIL: 'test@example.com',
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
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const [command, ...args] = serverCommand(port);
    child = spawn(command, args, { cwd: SIDECAR_ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
