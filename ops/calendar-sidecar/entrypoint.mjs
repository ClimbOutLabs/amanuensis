// Starts the calendar sidecar: the account agent, one CalDAV tool server per saved account, and the
// multiplexer that fronts them all at one HTTP address. Each tool server always starts from the
// account file, never from the environment Docker loaded, and restarts when its account changes.
// With no account saved nothing listens at the tool address, so no calendar tools are offered.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

import { allowedAddresses, defaultAccount, hostOf, parseAccounts } from './account.mjs';
import {
  createAgent,
  createAgentServer,
  DEFAULT_ACCOUNT_FILE,
  DEFAULT_PORT as DEFAULT_AGENT_PORT,
  readAccountText,
  secretIsUsable,
} from './agent.mjs';
import { createMux } from './mux.mjs';

const POLL_MS = 2000;
/** The first loopback port a per-account tool server takes. The multiplexer holds the public port. */
const GATEWAY_BASE_PORT = 19558;

function modulePath(relative) {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/** The command line of one account's tool server, which serves the CalDAV tools over HTTP. */
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
  // One running tool server per account: its loopback port, its child, and the hash of the account
  // text it was started from, so a change to one account restarts only that account's server.
  const running = new Map();
  let mux = null;
  let ticking = false;

  function targets() {
    const list = parseAccounts(readAccountText(file));
    const first = defaultAccount(list);
    const ordered = first === null ? list.accounts : [first, ...list.accounts.filter(a => a.email !== first.email)];
    const out = [];
    for (const account of ordered) {
      const entry = running.get(account.email);
      if (entry !== undefined) {
        out.push({ email: account.email, url: `http://127.0.0.1:${entry.port}/mcp` });
      }
    }
    return out;
  }

  function stopGateway(email) {
    const entry = running.get(email);
    if (entry !== undefined) {
      entry.child.kill('SIGTERM');
      running.delete(email);
    }
  }

  function freePort() {
    const used = new Set([...running.values()].map(entry => entry.port));
    let candidate = GATEWAY_BASE_PORT;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  async function tick() {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      const list = parseAccounts(readAccountText(file));
      const wanted = new Map(list.accounts.map(account => [account.email, account]));
      for (const email of [...running.keys()]) {
        if (!wanted.has(email)) {
          stopGateway(email);
        }
      }
      for (const account of list.accounts) {
        const hash = hashOf(`${account.url}\n${account.username}\n${account.password}\n${account.email}`);
        const entry = running.get(account.email);
        const alive = entry !== undefined && entry.child.exitCode === null && entry.child.signalCode === null;
        if (entry !== undefined && entry.hash === hash && alive) {
          continue;
        }
        if (entry !== undefined) {
          stopGateway(account.email);
        }
        // An address that no longer passes the rules is not signed in to, whatever the file says.
        const allowed = await allowedAddresses(hostOf(account.url), deps);
        if (!allowed.ok) {
          continue;
        }
        const gatewayPort = freePort();
        const [command, args] = gatewayCommand({ host: '127.0.0.1', port: gatewayPort });
        const child = spawn(command, args, {
          stdio: ['ignore', 'inherit', 'inherit'],
          env: {
            ...withoutAgentSecret(process.env),
            CALDAV_URL: account.url,
            CALDAV_USERNAME: account.username,
            CALDAV_PASSWORD: account.password,
            CALDAV_USER_EMAIL: account.email,
          },
        });
        running.set(account.email, { port: gatewayPort, child, hash });
      }
      if (running.size > 0 && mux === null) {
        mux = createMux({ targets });
        mux.listen(port, host);
      } else if (running.size === 0 && mux !== null) {
        mux.close();
        mux = null;
      }
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
      for (const email of [...running.keys()]) {
        stopGateway(email);
      }
      if (mux !== null) {
        mux.close();
        mux = null;
      }
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
