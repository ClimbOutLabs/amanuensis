#!/usr/bin/env node
// One-off import of the demo mailbox set (demo/fixtures/mailbox/demo-set.json)
// into a throwaway Gmail account with users.messages.import. Messages keep their
// Date header as the received time and land unread in the inbox.
//
// Configuration comes only from environment variables or a gitignored
// `.env.test-mailbox` file at the repo root (never the command line):
//
//   TEST_MAILBOX_GMAIL_ACCESS_TOKEN    short-lived OAuth access token, or
//   TEST_MAILBOX_GMAIL_CLIENT_ID       OAuth client id          } used together to
//   TEST_MAILBOX_GMAIL_CLIENT_SECRET   OAuth client secret      } mint an access token
//   TEST_MAILBOX_GMAIL_REFRESH_TOKEN   OAuth refresh token      } on every run
//   TEST_MAILBOX_TO                    optional; abort unless the signed-in account matches
//
// Scope: https://www.googleapis.com/auth/gmail.modify. Importing alone needs
// only gmail.insert, but skipping messages that are already present means
// searching the mailbox, which gmail.insert does not allow.
//
// Usage:
//   pnpm demo:import-mailbox --dry-run   list what would be imported, no network
//   pnpm demo:import-mailbox             import for real

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { loadDemoSet, parseEnvFile } from './test-mailbox-env.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = path.join(rootDir, '.env.test-mailbox');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function loadConfig({ env = process.env, fileText } = {}) {
  const fileValues = fileText === undefined ? {} : parseEnvFile(fileText);
  const get = name => env[name] ?? fileValues[name] ?? '';
  return {
    accessToken: get('TEST_MAILBOX_GMAIL_ACCESS_TOKEN'),
    clientId: get('TEST_MAILBOX_GMAIL_CLIENT_ID'),
    clientSecret: get('TEST_MAILBOX_GMAIL_CLIENT_SECRET'),
    refreshToken: get('TEST_MAILBOX_GMAIL_REFRESH_TOKEN'),
    expectedAddress: get('TEST_MAILBOX_TO'),
  };
}

async function requestJson({ fetchImpl, url, init }) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail request failed (HTTP ${String(response.status)}): ${text.slice(0, 300)}`);
  }
  return text === '' ? {} : JSON.parse(text);
}

async function getAccessToken({ config, fetchImpl }) {
  if (config.accessToken !== '') {
    return config.accessToken;
  }
  if (config.clientId === '' || config.clientSecret === '' || config.refreshToken === '') {
    throw new Error(
      'No Gmail credentials found. Set TEST_MAILBOX_GMAIL_ACCESS_TOKEN, or all of ' +
        'TEST_MAILBOX_GMAIL_CLIENT_ID, TEST_MAILBOX_GMAIL_CLIENT_SECRET and TEST_MAILBOX_GMAIL_REFRESH_TOKEN, ' +
        'in the environment or in .env.test-mailbox.',
    );
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });
  const token = await requestJson({
    fetchImpl,
    url: TOKEN_URL,
    init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
  });
  if (typeof token.access_token !== 'string') {
    throw new Error('The token endpoint did not return an access token.');
  }
  return token.access_token;
}

function gmailInit({ token, method = 'GET', body }) {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function describe({ message }) {
  return `${message.date} | ${message.language} | ${message.subject} (${message.file})`;
}

export async function importDemoMailbox({ config, messages, fetchImpl = fetch, dryRun = false, log = console.log }) {
  if (dryRun) {
    log(`Dry run: ${String(messages.length)} messages would be imported (nothing was sent):`);
    for (const message of messages) {
      log(`  ${describe({ message })}`);
    }
    return { imported: [], skipped: [], dryRun: true };
  }

  const token = await getAccessToken({ config, fetchImpl });
  const profile = await requestJson({ fetchImpl, url: `${GMAIL_API}/profile`, init: gmailInit({ token }) });
  if (config.expectedAddress !== '' && profile.emailAddress !== config.expectedAddress) {
    throw new Error(
      `Signed in as ${String(profile.emailAddress)}, but TEST_MAILBOX_TO expects ${config.expectedAddress}. Nothing was imported.`,
    );
  }
  log(`Importing into ${String(profile.emailAddress)}.`);

  const imported = [];
  const skipped = [];
  for (const message of messages) {
    const search = new URLSearchParams({
      q: `rfc822msgid:${message.messageId.replace(/^<|>$/g, '')}`,
      includeSpamTrash: 'true',
      maxResults: '1',
    });
    const found = await requestJson({
      fetchImpl,
      url: `${GMAIL_API}/messages?${search.toString()}`,
      init: gmailInit({ token }),
    });
    if (Array.isArray(found.messages) && found.messages.length > 0) {
      skipped.push(message);
      log(`  skipped (already in the mailbox): ${message.subject}`);
      continue;
    }
    const query = new URLSearchParams({ internalDateSource: 'dateHeader', neverMarkSpam: 'true' });
    await requestJson({
      fetchImpl,
      url: `${GMAIL_API}/messages/import?${query.toString()}`,
      init: gmailInit({
        token,
        method: 'POST',
        body: { raw: message.raw.toString('base64url'), labelIds: ['INBOX', 'UNREAD'] },
      }),
    });
    imported.push(message);
    log(`  imported: ${message.subject}`);
  }
  return { imported, skipped, dryRun: false };
}

export function summarize({ result, total }) {
  if (result.dryRun) {
    return `Dry run only. ${String(total)} messages would be considered.`;
  }
  const { imported, skipped } = result;
  const lines = [`Done. ${String(imported.length)} of ${String(total)} messages imported as unread in the inbox.`];
  if (skipped.length > 0) {
    lines.push(`${String(skipped.length)} already in the mailbox, so left alone (running again is safe).`);
  }
  return lines.join(' ');
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const config = loadConfig({
    fileText: existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined,
  });
  const messages = loadDemoSet();
  const result = await importDemoMailbox({ config, messages, dryRun });
  console.log(summarize({ result, total: messages.length }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Import stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
