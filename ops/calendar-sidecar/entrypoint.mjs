// Starts the calendar sidecar: the account agent, and the CalDAV tool server behind a plain HTTP address
// while an account is saved. The tool server always starts from the account file, never from the
// environment Docker loaded, and it restarts when that file changes. With no account saved it is not
// started at all, so no calendar tools are offered. When the account's calendars live on another host
// than the saved address (iCloud), the tool server is started on that host once the sign-in walk has
// checked it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

import { allowedAddresses, hostOf, parseAccount } from './account.mjs';
import {
  createAgent,
  createAgentServer,
  DEFAULT_ACCOUNT_FILE,
  DEFAULT_PORT as DEFAULT_AGENT_PORT,
  readAccountText,
  secretIsUsable,
} from './agent.mjs';
import { discoverCalendarServer } from './signin.mjs';

const POLL_MS = 2000;

function modulePath(relative) {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/** The command line of the tool server, which serves the CalDAV tools over HTTP. */
export function gatewayCommand({ host, port }) {
  return [
    process.execPath,
    [
      modulePath('./node_modules/supergateway/dist/index.js'),
      '--stdio',
      `node ${modulePath('./node_modules/@ni-c/caldav-mcp/dist/index.js')}`,
      '--outputTransport',
      'streamableHttp',
      '--host',
      host,
      '--port',
      String(port),
      '--streamableHttpPath',
      '/mcp',
      // No gateway log lines at all: a calendar server's error text can echo the login, and this
      // version accepts only debug, info and none.
      '--logLevel',
      'none',
    ],
  ];
}

/** The tool server needs the login, never the secret that guards the account port. */
function withoutAgentSecret(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'CALENDAR_ACCOUNT_SECRET'));
}

const hashOf = text => createHash('sha256').update(text, 'utf8').digest('hex');

// How soon the supervisor asks again which address the tool server belongs on: soon after a failed walk,
// growing to the cap, and every half hour once it has an answer, in case the provider moved the account.
export const DISCOVERY_RETRY_MS = { first: 15_000, cap: 600_000, settled: 1_800_000 };

export function startSupervisor({ file, host, port, deps = {} }) {
  const now = deps.now ?? Date.now;
  const launch = deps.spawn ?? spawn;
  let child = null;
  let running = null;
  let serverUrl = null;
  let inFlight = null;
  let discovery = { hash: null, at: 0, wait: DISCOVERY_RETRY_MS.first, url: null };

  function stop() {
    if (child !== null) {
      child.kill('SIGTERM');
      child = null;
    }
    running = null;
    serverUrl = null;
  }

  function start({ account, hash, url }) {
    const [command, args] = gatewayCommand({ host, port });
    child = launch(command, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...withoutAgentSecret(process.env),
        CALDAV_URL: url,
        CALDAV_USERNAME: account.username,
        CALDAV_PASSWORD: account.password,
        CALDAV_USER_EMAIL: account.email,
      },
    });
    running = hash;
    serverUrl = url;
  }

  // Which address the tool server belongs on: the walk's answer when it passes, the saved address until then.
  async function wantedUrl({ account, hash }) {
    if (discovery.hash !== hash) {
      discovery = { hash, at: 0, wait: DISCOVERY_RETRY_MS.first, url: null };
    }
    if (now() >= discovery.at) {
      const found = await discoverCalendarServer(account, deps);
      if (found.result === 'ok') {
        discovery = {
          hash,
          at: now() + DISCOVERY_RETRY_MS.settled,
          wait: DISCOVERY_RETRY_MS.first,
          url: found.server_url,
        };
      } else {
        const wait = Math.min(discovery.wait * 2, DISCOVERY_RETRY_MS.cap);
        discovery = { hash, at: now() + discovery.wait, wait, url: discovery.url };
      }
    }
    return discovery.url ?? account.url;
  }

  // One round at a time: a call while a round runs waits for that round instead of starting another.
  function tick() {
    inFlight ??= round().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function round() {
    const text = readAccountText(file);
    const account = parseAccount(text);
    const hash = account === null ? null : hashOf(text);
    const alive = child !== null && child.exitCode === null && child.signalCode === null;
    if (hash !== running || !alive) {
      stop();
      if (account === null) {
        return;
      }
      // An address that no longer passes the rules is not signed in to, whatever the file says.
      const allowed = await allowedAddresses(hostOf(account.url), deps);
      if (!allowed.ok) {
        return;
      }
      // The saved address serves until the walk says where the calendars are, so the tools are offered
      // straight away and a calendar server that is down for now does not hide them.
      start({ account, hash, url: discovery.hash === hash && discovery.url !== null ? discovery.url : account.url });
    }
    const url = await wantedUrl({ account, hash });
    if (url !== serverUrl && hash === running) {
      stop();
      start({ account, hash, url });
    }
  }

  // A failed round is tried again at the next one; it must never end the process.
  const safeTick = () => tick().catch(() => undefined);
  const timer = setInterval(safeTick, POLL_MS);
  void safeTick();
  return {
    tick,
    stop() {
      clearInterval(timer);
      stop();
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.env.CALENDAR_ACCOUNT_FILE ?? DEFAULT_ACCOUNT_FILE;
  const agentPort = Number(process.env.CALENDAR_ACCOUNT_PORT ?? DEFAULT_AGENT_PORT);
  const secret = process.env.CALENDAR_ACCOUNT_SECRET;
  // Without a usable secret the account port stays closed. The saved account is still served, and the
  // installer still writes it through the command line.
  const server = secretIsUsable(secret) ? createAgentServer({ agent: createAgent({ file }), secret }) : null;
  if (server === null) {
    process.stderr.write('calendar account agent: no account secret is set, so its port is closed\n');
  } else {
    server.listen(agentPort, '0.0.0.0');
  }
  const supervisor = startSupervisor({
    file,
    host: process.env.CALENDAR_MCP_HOST ?? '0.0.0.0',
    port: Number(process.env.CALENDAR_MCP_PORT ?? 9558),
  });
  const shutdown = () => {
    supervisor.stop();
    server?.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
