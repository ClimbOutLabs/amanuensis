#!/usr/bin/env node
// Sends the synthetic test mailbox fixtures over SMTP to a test mailbox.
//
// Configuration comes only from environment variables or a gitignored
// `.env.test-mailbox` file at the repo root (never committed):
//
//   TEST_MAILBOX_TO           recipient address (required)
//   TEST_MAILBOX_SMTP_HOST    SMTP host (required)
//   TEST_MAILBOX_SMTP_PORT    SMTP port (default 587)
//   TEST_MAILBOX_SMTP_SECURE  "true" for implicit TLS (default true on port 465)
//   TEST_MAILBOX_SMTP_USER    SMTP username (optional)
//   TEST_MAILBOX_SMTP_PASS    SMTP password (optional)
//   TEST_MAILBOX_FROM         envelope sender (default: TEST_MAILBOX_TO)
//
// Usage:
//   pnpm send-test-mailbox --dry-run   print what would be sent
//   pnpm send-test-mailbox             send for real

import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './test-mailbox-env.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(rootDir, 'demo', 'fixtures', 'mailbox');
const envFile = path.join(rootDir, '.env.test-mailbox');

function loadConfig() {
  const fileValues = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
  const get = name => process.env[name] ?? fileValues[name] ?? '';
  const port = Number.parseInt(get('TEST_MAILBOX_SMTP_PORT') || '587', 10);
  const secureRaw = get('TEST_MAILBOX_SMTP_SECURE');
  return {
    to: get('TEST_MAILBOX_TO'),
    host: get('TEST_MAILBOX_SMTP_HOST'),
    port: Number.isSafeInteger(port) ? port : 587,
    secure: secureRaw !== '' ? secureRaw === 'true' : port === 465,
    user: get('TEST_MAILBOX_SMTP_USER'),
    pass: get('TEST_MAILBOX_SMTP_PASS'),
    from: get('TEST_MAILBOX_FROM'),
  };
}

// Minimal SMTP conversation driver over a socket.
function smtpSession(socket) {
  let buffer = '';
  let pending = [];
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    drain();
  });
  socket.on('error', err => {
    const reject = pending;
    pending = [];
    for (const { reject: rej } of reject) {
      rej(err);
    }
  });

  function drain() {
    const lines = [];
    for (;;) {
      const idx = buffer.indexOf('\r\n');
      if (idx < 0) {
        break;
      }
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
    if (lines.length === 0 || pending.length === 0) {
      return;
    }
    // Collect a full (possibly multi-line) reply, then resolve the oldest
    // pending command.
    const reply = [];
    let complete = false;
    for (const line of lines) {
      reply.push(line);
      if (/^\d{3} /.test(line)) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      return;
    }
    const [{ resolve, reject }] = pending.splice(0, 1);
    const code = Number.parseInt(reply[reply.length - 1].slice(0, 3), 10);
    if (code >= 400) {
      reject(new Error(`SMTP error: ${reply.join(' | ')}`));
    } else {
      resolve(reply);
    }
  }

  function command(text) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      socket.write(`${text}\r\n`, 'utf8');
    });
  }

  function greeting() {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  }

  return { command, greeting, socket };
}

function parseHeaders(raw) {
  const headers = {};
  const head = raw.split('\r\n\r\n')[0] ?? '';
  let current = '';
  for (const line of head.split('\r\n')) {
    if (/^\s/.test(line) && current !== '') {
      headers[current] += ` ${line.trim()}`;
    } else {
      const idx = line.indexOf(':');
      if (idx > 0) {
        current = line.slice(0, idx).trim().toLowerCase();
        headers[current] = line.slice(idx + 1).trim();
      }
    }
  }
  return headers;
}

function listFixtures() {
  return readdirSync(fixtureDir)
    .filter(name => name.endsWith('.eml'))
    .sort()
    .map(name => {
      const raw = readFileSync(path.join(fixtureDir, name), 'utf8');
      const headers = parseHeaders(raw);
      return {
        name,
        from: headers.from ?? '(unknown)',
        subject: headers.subject ?? '(no subject)',
        date: headers.date ?? '(no date)',
        bytes: Buffer.byteLength(raw, 'utf8'),
        raw,
      };
    });
}

async function sendAll({ config, fixtures }) {
  const rawSocket = config.secure
    ? tlsConnect({ host: config.host, port: config.port })
    : connect({ host: config.host, port: config.port });
  await new Promise((resolve, reject) => {
    rawSocket.once('connect', resolve);
    rawSocket.once('error', reject);
  });

  const startSession = async socket => {
    const session = smtpSession(socket);
    await session.greeting();
    let reply = await session.command('EHLO fixture-sender');
    const offersStartTls = reply.some(line => /STARTTLS/i.test(line));
    if (!config.secure && offersStartTls) {
      await session.command('STARTTLS');
      const upgraded = tlsConnect({ socket, host: config.host });
      await new Promise((resolve, reject) => {
        upgraded.once('secureConnect', resolve);
        upgraded.once('error', reject);
      });
      const upgradedSession = smtpSession(upgraded);
      await upgradedSession.greeting();
      reply = await upgradedSession.command('EHLO fixture-sender');
      return { session: upgradedSession, extensions: reply, tls: true };
    }
    return { session, extensions: reply, tls: config.secure };
  };

  const { session, extensions, tls } = await startSession(rawSocket);

  if (config.user !== '') {
    if (!tls) {
      throw new Error('refusing to send SMTP credentials over an unencrypted connection');
    }
    const offersAuth = extensions.some(line => /^250[ -]AUTH/i.test(line));
    if (!offersAuth) {
      throw new Error('SMTP server does not offer AUTH');
    }
    await session.command('AUTH LOGIN');
    await session.command(Buffer.from(config.user, 'utf8').toString('base64'));
    await session.command(Buffer.from(config.pass, 'utf8').toString('base64'));
  }

  const envelopeFrom = config.from !== '' ? config.from : config.to;
  for (const fixture of fixtures) {
    await session.command(`MAIL FROM:<${envelopeFrom}>`);
    await session.command(`RCPT TO:<${config.to}>`);
    await session.command('DATA');
    // Dot-stuffing: lines starting with a dot get an extra dot.
    const stuffed = fixture.raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => (line.startsWith('.') ? `.${line}` : line))
      .join('\r\n');
    await session.command(`${stuffed}\r\n.`);
    console.log(`sent ${fixture.name} -> ${config.to}`);
  }
  await session.command('QUIT');
  session.socket.end();
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  for (const arg of args) {
    if (arg !== '--dry-run') {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    throw new Error(`no .eml fixtures found in ${fixtureDir}`);
  }

  if (dryRun) {
    console.log(`would send ${fixtures.length} messages:`);
    for (const fixture of fixtures) {
      console.log(`  ${fixture.name} | from: ${fixture.from} | subject: ${fixture.subject} | ${fixture.bytes} bytes`);
    }
    return;
  }

  const config = loadConfig();
  if (config.to === '' || config.host === '') {
    throw new Error('TEST_MAILBOX_TO and TEST_MAILBOX_SMTP_HOST are required ' + '(environment or .env.test-mailbox)');
  }
  sendAll({ config, fixtures }).catch(err => {
    console.error(`send failed: ${err.message}`);
    process.exitCode = 1;
  });
}

main();
