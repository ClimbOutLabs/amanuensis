// Starts the calendar sidecar: the account agent, and the CalDAV tool server behind a plain HTTP address
// while an account is saved. The tool server always starts from the account file, never from the
// environment Docker loaded, and it restarts when that file changes. With no account saved it is not
// started at all, so no calendar tools are offered.
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

export function startSupervisor({ file, host, port, deps = {} }) {
  let child = null;
  let running = null;
  let ticking = false;

  function stop() {
    if (child !== null) {
      child.kill('SIGTERM');
      child = null;
    }
    running = null;
  }

  async function tick() {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      const text = readAccountText(file);
      const account = parseAccount(text);
      const wanted = account === null ? null : hashOf(text);
      const alive = child !== null && child.exitCode === null && child.signalCode === null;
      if (wanted === running && (wanted === null || alive)) {
        return;
      }
      stop();
      if (account === null) {
        return;
      }
      // An address that no longer passes the rules is not signed in to, whatever the file says.
      const allowed = await allowedAddresses(hostOf(account.url), deps);
      if (!allowed.ok) {
        return;
      }
      const [command, args] = gatewayCommand({ host, port });
      child = spawn(command, args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...withoutAgentSecret(process.env),
          CALDAV_URL: account.url,
          CALDAV_USERNAME: account.username,
          CALDAV_PASSWORD: account.password,
          CALDAV_USER_EMAIL: account.email,
        },
      });
      running = wanted;
    } finally {
      ticking = false;
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
