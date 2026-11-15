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
  defaultAccount,
  hostOf,
  parseAccounts,
  publicAccount,
  renderAccounts,
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
  // The last sign-in result per account, keyed by its address. An account is rechecked when its own
  // saved text changes or the cached answer ages out, never because another account changed.
  const checks = new Map();
  let busy = Promise.resolve();

  // One request at a time, so a save and a status check never interleave.
  function serialized(work) {
    const run = busy.then(work, work);
    busy = run.catch(() => undefined);
    return run;
  }

  async function signInWord(account) {
    const fingerprint = fingerprintOf(renderAccounts([account], null));
    const cached = checks.get(account.email);
    if (cached !== undefined && cached.fingerprint === fingerprint && now() - cached.at < RECHECK_AFTER_MS) {
      return SIGN_IN_WORDS[cached.result];
    }
    const result = await checkSignIn(account, deps);
    checks.set(account.email, { fingerprint, at: now(), result });
    return SIGN_IN_WORDS[result];
  }

  async function statusBody(list) {
    const entries = [];
    for (const account of list.accounts) {
      entries.push({ ...publicAccount(account), sign_in: await signInWord(account) });
    }
    const current = defaultAccount(list);
    const currentEntry = entries.find(entry => entry.email === current?.email);
    return {
      connected: true,
      // The flat fields name the default account, for a reader that predates the list.
      ...publicAccount(current),
      sign_in: currentEntry?.sign_in ?? 'unreachable',
      accounts: entries,
      default: current.email,
    };
  }

  async function status() {
    const list = parseAccounts(readAccountText(file));
    if (list.accounts.length === 0) {
      return { status: 200, body: { connected: false } };
    }
    return { status: 200, body: await statusBody(list) };
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
    const list = parseAccounts(readAccountText(file));
    const at = list.accounts.findIndex(account => account.email === candidate.email);
    if (at >= 0) {
      list.accounts[at] = candidate;
    } else {
      list.accounts.push(candidate);
    }
    writeAccountText({ file, text: renderAccounts(list.accounts, defaultAccount(list)?.email ?? null) });
    checks.set(candidate.email, {
      fingerprint: fingerprintOf(renderAccounts([candidate], null)),
      at: now(),
      result: 'ok',
    });
    return { status: 200, body: await statusBody(parseAccounts(readAccountText(file))) };
  }

  async function remove(payload) {
    const address =
      payload !== null && typeof payload === 'object' && typeof payload.address === 'string' ? payload.address : null;
    if (address === null) {
      removeAccountFile(file);
      checks.clear();
      return { status: 200, body: { connected: false } };
    }
    const list = parseAccounts(readAccountText(file));
    const kept = list.accounts.filter(account => account.email !== address);
    checks.delete(address);
    if (kept.length === 0) {
      removeAccountFile(file);
      return { status: 200, body: { connected: false } };
    }
    const nextDefault = defaultAccount({ accounts: kept, defaultEmail: list.defaultEmail })?.email ?? null;
    writeAccountText({ file, text: renderAccounts(kept, nextDefault) });
    return { status: 200, body: await statusBody(parseAccounts(readAccountText(file))) };
  }

  async function setDefault(payload) {
    const address =
      payload !== null && typeof payload === 'object' && typeof payload.address === 'string' ? payload.address : null;
    const list = parseAccounts(readAccountText(file));
    if (address === null || !list.accounts.some(account => account.email === address)) {
      return { status: 400, body: { error: 'invalid' } };
    }
    writeAccountText({ file, text: renderAccounts(list.accounts, address) });
    return { status: 200, body: await statusBody(parseAccounts(readAccountText(file))) };
  }

  return {
    status: () => serialized(status),
    save: payload => serialized(() => save(payload)),
    remove: payload => serialized(() => remove(payload)),
    setDefault: payload => serialized(() => setDefault(payload)),
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
      if (req.url !== '/account' && req.url !== '/account/default') {
        send(res, { status: 404, body: { error: 'not_found' } });
        return;
      }
      if (req.method === 'GET' && req.url === '/account') {
        send(res, await agent.status());
        return;
      }
      if (req.method === 'DELETE' && req.url === '/account') {
        // A delete may name one account in a JSON body; with no body, every account goes.
        const raw = await readBody(req).catch(() => '');
        let payload = null;
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw);
          } catch {
            send(res, { status: 400, body: { error: 'invalid' } });
            return;
          }
        }
        send(res, await agent.remove(payload));
        return;
      }
      if (req.method === 'POST') {
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
        send(res, req.url === '/account/default' ? await agent.setDefault(payload) : await agent.save(payload));
        return;
      }
      send(res, { status: 405, body: { error: 'method_not_allowed' } });
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
    const incoming = text === null || text === '' ? { accounts: [], defaultEmail: null } : parseAccounts(text);
    if (incoming.accounts.length === 0) {
      err.write('calendar account agent: refused incomplete account text\n');
      return 2;
    }
    for (const account of incoming.accounts) {
      const allowed = await allowedAddresses(hostOf(account.url), deps);
      if (!allowed.ok) {
        err.write(
          allowed.reason === 'blocked'
            ? 'calendar account agent: refused an address this service may not use\n'
            : 'calendar account agent: refused an address that could not be found\n',
        );
        return 3;
      }
    }
    try {
      // Text carrying a default line or several accounts is a whole list and replaces the file. A
      // single account with no default line, which is what the installer writes, is merged in: an
      // account with the same address is replaced, the others are kept.
      if (incoming.defaultEmail !== null || incoming.accounts.length > 1) {
        writeAccountText({ file, text: renderAccounts(incoming.accounts, incoming.defaultEmail) });
      } else {
        const current = parseAccounts(readAccountText(file));
        const candidate = incoming.accounts[0];
        const at = current.accounts.findIndex(account => account.email === candidate.email);
        if (at >= 0) {
          current.accounts[at] = candidate;
        } else {
          current.accounts.push(candidate);
        }
        writeAccountText({
          file,
          text: renderAccounts(current.accounts, defaultAccount(current)?.email ?? null),
        });
      }
    } catch (caught) {
      err.write(`calendar account agent: account write failed (${caught?.name ?? 'Error'})\n`);
      return 1;
    }
    out.write('saved\n');
    return 0;
  }
  if (command === '--remove') {
    try {
      const address = deps.address ?? null;
      if (address === null) {
        removeAccountFile(file);
      } else {
        const list = parseAccounts(readAccountText(file));
        const kept = list.accounts.filter(account => account.email !== address);
        if (kept.length === 0) {
          removeAccountFile(file);
        } else {
          const nextDefault = defaultAccount({ accounts: kept, defaultEmail: list.defaultEmail })?.email ?? null;
          writeAccountText({ file, text: renderAccounts(kept, nextDefault) });
        }
      }
    } catch (caught) {
      err.write(`calendar account agent: account remove failed (${caught?.name ?? 'Error'})\n`);
      return 1;
    }
    out.write('removed\n');
    return 0;
  }
  if (command === '--check') {
    const account = defaultAccount(parseAccounts(readAccountText(file)));
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
  const address = process.argv[3] ?? null;
  process.exitCode = await runCommand({
    command: process.argv[2],
    file,
    stdin: readStdin,
    deps: { address },
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
