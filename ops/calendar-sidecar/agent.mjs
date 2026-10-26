// The calendar sidecar's account agent: the Settings Calendar card's counterpart inside the sidecar.
// It listens on the instance's private network only (the port is exposed inside the compose network,
// never published). The account lives in one file in the sidecar's own volume. The installer writes it
// through this file's command line, and the Settings card writes it through the HTTP port. The
// supervisor in entrypoint.mjs restarts the tool server whenever that file changes.
//
// Rules kept here:
// - The password is accepted only in a save request or on stdin, is checked before anything is stored,
//   and is never written to a log, a response or an error. Answers are fixed words only, so a calendar
//   server's own text never reaches the app.
// - Nothing is logged: the server prints no request lines, and an unexpected failure prints only the
//   exception's type name.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accountIsWellFormed,
  allowedAddresses,
  hostOf,
  parseAccount,
  publicAccount,
  renderAccount,
} from './account.mjs';
import { checkSignIn } from './signin.mjs';

export const DEFAULT_ACCOUNT_FILE = '/account/.env.calendar';
export const DEFAULT_PORT = 9560;
const ALLOWED_HOSTS = new Set(['calendar-caldav', 'localhost', '127.0.0.1']);
const RECHECK_AFTER_MS = 300_000;
const MAX_BODY_BYTES = 65_536;

export function readAccountText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Writes the whole file in one step and keeps it private to the sidecar's user. */
export function writeAccountText({ file, text }) {
  const temporary = join(dirname(file), `.calendar-account-${process.pid}.tmp`);
  const fd = openSync(temporary, 'w', 0o600);
  try {
    try {
      chmodSync(temporary, 0o600);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (caught) {
    // A half-written copy of the login must not be left behind.
    rmSync(temporary, { force: true });
    throw caught;
  }
}

export function removeAccountFile(file) {
  try {
    unlinkSync(file);
  } catch (caught) {
    if (caught?.code !== 'ENOENT') {
      throw caught;
    }
  }
}

function fingerprintOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const SIGN_IN_WORDS = { ok: 'ok', login: 'refused', server: 'unreachable', blocked: 'unreachable' };

/** Builds the agent. `deps` replaces the network and the clock in tests. */
export function createAgent({ file = DEFAULT_ACCOUNT_FILE, deps = {} } = {}) {
  const now = deps.now ?? Date.now;
  let last = { fingerprint: null, at: 0, result: null };
  let busy = Promise.resolve();

  // One request at a time, so a save and a status check never interleave.
  function serialized(work) {
    const run = busy.then(work, work);
    busy = run.catch(() => undefined);
    return run;
  }

  async function status() {
    const text = readAccountText(file);
    const account = parseAccount(text);
    if (account === null) {
      return { status: 200, body: { connected: false } };
    }
    const fingerprint = fingerprintOf(text);
    const fresh = last.fingerprint === fingerprint && last.result !== null && now() - last.at < RECHECK_AFTER_MS;
    if (!fresh) {
      last = { fingerprint, at: now(), result: await checkSignIn(account, deps) };
    }
    return {
      status: 200,
      body: { connected: true, ...publicAccount(account), sign_in: SIGN_IN_WORDS[last.result] },
    };
  }

  async function save(payload) {
    const candidate =
      payload !== null && typeof payload === 'object'
        ? { url: payload.url, username: payload.username, password: payload.password, email: payload.email }
        : null;
    if (!accountIsWellFormed(candidate)) {
      return { status: 400, body: { error: 'invalid' } };
    }
    const result = await checkSignIn(candidate, deps);
    if (result === 'blocked') {
      return { status: 400, body: { error: 'address_not_allowed' } };
    }
    if (result === 'login') {
      return { status: 400, body: { error: 'sign_in_refused' } };
    }
    if (result !== 'ok') {
      return { status: 400, body: { error: 'server_unreachable' } };
    }
    const text = renderAccount(candidate);
    writeAccountText({ file, text });
    last = { fingerprint: fingerprintOf(text), at: now(), result: 'ok' };
    return { status: 200, body: { connected: true, ...publicAccount(candidate), sign_in: 'ok' } };
  }

  async function remove() {
    removeAccountFile(file);
    last = { fingerprint: null, at: 0, result: null };
    return { status: 200, body: { connected: false } };
  }

  return {
    status: () => serialized(status),
    save: payload => serialized(() => save(payload)),
    remove: () => serialized(remove),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The HTTP face of the agent, with no request log. */
export function createAgentServer({ agent }) {
  function send(res, { status, body }) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  return createServer(async (req, res) => {
    try {
      const name = (req.headers.host ?? '').split(':')[0].trim().toLowerCase();
      if (!ALLOWED_HOSTS.has(name)) {
        send(res, { status: 403, body: { error: 'forbidden_host' } });
        return;
      }
      if (req.url !== '/account') {
        send(res, { status: 404, body: { error: 'not_found' } });
        return;
      }
      if (req.method === 'GET') {
        send(res, await agent.status());
      } else if (req.method === 'DELETE') {
        send(res, await agent.remove());
      } else if (req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          send(res, { status: 400, body: { error: 'invalid' } });
          return;
        }
        send(res, await agent.save(payload));
      } else {
        send(res, { status: 405, body: { error: 'method_not_allowed' } });
      }
    } catch (caught) {
      // Fixed words only: exception text can carry the login.
      process.stderr.write(`calendar account agent: request failed (${caught?.name ?? 'Error'})\n`);
      try {
        send(res, { status: 500, body: { error: 'internal' } });
      } catch {
        // The connection is already gone.
      }
    }
  });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The installer's commands. Each prints one fixed word and returns the exit code.
 * --write-stdin stores the account file's text from stdin after the same checks a save makes, except the
 * sign-in itself, which --check reports so the installer can say what to fix and keep the account.
 */
export async function runCommand({ command, file, stdin, deps = {}, out = process.stdout, err = process.stderr }) {
  if (command === '--write-stdin') {
    const text = await stdin();
    const account = text === null || text === '' ? null : parseAccount(text);
    if (account === null) {
      err.write('calendar account agent: refused incomplete account text\n');
      return 2;
    }
    const allowed = await allowedAddresses(hostOf(account.url), deps);
    if (!allowed.ok) {
      err.write(
        allowed.reason === 'blocked'
          ? 'calendar account agent: refused an address this service may not use\n'
          : 'calendar account agent: refused an address that could not be found\n',
      );
      return 3;
    }
    try {
      writeAccountText({ file, text: renderAccount(account) });
    } catch (caught) {
      err.write(`calendar account agent: account write failed (${caught?.name ?? 'Error'})\n`);
      return 1;
    }
    out.write('saved\n');
    return 0;
  }
  if (command === '--remove') {
    try {
      removeAccountFile(file);
    } catch (caught) {
      err.write(`calendar account agent: account remove failed (${caught?.name ?? 'Error'})\n`);
      return 1;
    }
    out.write('removed\n');
    return 0;
  }
  if (command === '--check') {
    const account = parseAccount(readAccountText(file));
    if (account === null) {
      out.write('none\n');
      return 0;
    }
    out.write(`${await checkSignIn(account, deps)}\n`);
    return 0;
  }
  err.write('calendar account agent: unknown command\n');
  return 2;
}

async function main() {
  const file = process.env.CALENDAR_ACCOUNT_FILE ?? DEFAULT_ACCOUNT_FILE;
  const command = process.argv[2];
  if (command === undefined) {
    const port = Number(process.env.CALENDAR_ACCOUNT_PORT ?? DEFAULT_PORT);
    createAgentServer({ agent: createAgent({ file }) }).listen(port, '0.0.0.0');
    return;
  }
  process.exitCode = await runCommand({ command, file, stdin: readStdin });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
