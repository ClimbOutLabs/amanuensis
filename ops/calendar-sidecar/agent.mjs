// The calendar sidecar's account agent: the Settings Calendar card's counterpart inside the sidecar.
// It listens on a private network that only the app shares (the port is exposed inside the compose
// network, never published), and answers only a caller that presents the instance's secret. The account
// lives in one file in the sidecar's own volume. The installer writes it through this file's command line,
// and the Settings card writes it through the HTTP port. The supervisor in entrypoint.mjs restarts the
// tool server whenever that file changes.
//
// Rules kept here:
// - The password is accepted only in a save request or on stdin, is checked before anything is stored,
//   and is never written to a log, a response or an error. Answers are fixed words only, so a calendar
//   server's own text never reaches the app.
// - Nothing is logged: the server prints no request lines, and an unexpected failure prints only the
//   exception's type name.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
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
  accountProblem,
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
/** A shorter secret is treated as none: the account port stays closed rather than guarded by a weak value. */
export const MIN_SECRET_LENGTH = 32;
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

// What a status answer says about the saved login. Anything but ok or refused means the tool server cannot
// sign in right now, which the app shows as "not working".
const SIGN_IN_WORDS = {
  ok: 'ok',
  login: 'refused',
  server: 'unreachable',
  blocked: 'unreachable',
  certificate: 'unreachable',
  redirect: 'unreachable',
};

// What a save answers when the sign-in check does not pass.
const SAVE_REFUSALS = {
  blocked: 'address_not_allowed',
  login: 'sign_in_refused',
  certificate: 'certificate_refused',
  redirect: 'redirected',
  server: 'server_unreachable',
};

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
    const problem = accountProblem(candidate);
    if (problem !== null) {
      // The field's name is a fixed word, so the app can say which value to fix without repeating it.
      return { status: 400, body: { error: 'invalid', field: problem } };
    }
    const result = await checkSignIn(candidate, deps);
    if (result !== 'ok') {
      return { status: 400, body: { error: SAVE_REFUSALS[result] ?? 'server_unreachable' } };
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

/** True when the secret is long enough to guard the account port. */
export function secretIsUsable(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

/** Compares the presented header with the secret in constant time, whatever the lengths. */
function presentedSecretMatches({ header, secret }) {
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** True for a JSON body, with or without a charset; any other kind of body is refused. */
function isJsonContentType(header) {
  return typeof header === 'string' && /^application\/json\s*(;|$)/i.test(header.trim());
}

/**
 * The HTTP face of the agent, with no request log. Every request must carry the instance's secret as a
 * bearer token, so another container on the network cannot read, replace or delete the account.
 */
export function createAgentServer({ agent, secret }) {
  if (!secretIsUsable(secret)) {
    throw new Error('the account agent needs a secret of at least 32 characters');
  }
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
      if (!presentedSecretMatches({ header: req.headers.authorization, secret })) {
        send(res, { status: 401, body: { error: 'unauthorized' } });
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
        if (!isJsonContentType(req.headers['content-type'])) {
          send(res, { status: 415, body: { error: 'unsupported_media_type' } });
          return;
        }
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
  process.exitCode = await runCommand({ command: process.argv[2], file, stdin: readStdin });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
