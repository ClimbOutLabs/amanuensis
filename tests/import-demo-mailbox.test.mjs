import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';
import { importDemoMailbox, loadConfig, loadDemoSet, summarize } from '../demo/scripts/import-demo-mailbox.mjs';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'demo',
  'fixtures',
  'mailbox',
);
const messages = loadDemoSet({ fixtureDir });
const quiet = () => undefined;

function jsonResponse({ body, status = 200 }) {
  return { ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

// A fake Gmail: `present` holds Message-IDs (without angle brackets) already in the mailbox.
function fakeGmail({ present = [], address = 'throwaway@example.com', failImportFor } = {}) {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.host === 'oauth2.googleapis.com') {
      return Promise.resolve(jsonResponse({ body: { access_token: 'minted' } }));
    }
    if (parsed.pathname.endsWith('/profile')) {
      return Promise.resolve(jsonResponse({ body: { emailAddress: address } }));
    }
    if (parsed.pathname.endsWith('/messages/import')) {
      const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('latin1');
      if (failImportFor !== undefined && raw.includes(failImportFor)) {
        return Promise.resolve(jsonResponse({ body: { error: { message: 'boom' } }, status: 500 }));
      }
      return Promise.resolve(jsonResponse({ body: { id: 'new' } }));
    }
    const id = parsed.searchParams.get('q').replace('rfc822msgid:', '');
    return Promise.resolve(jsonResponse({ body: present.includes(id) ? { messages: [{ id: 'old' }] } : {} }));
  };
  return { calls, fetchImpl };
}

const tokenConfig = loadConfig({ env: { TEST_MAILBOX_GMAIL_ACCESS_TOKEN: 'given' } });

test('config reads the environment first, then the env file', () => {
  const config = loadConfig({
    env: { TEST_MAILBOX_GMAIL_CLIENT_ID: 'from-env' },
    fileText: 'TEST_MAILBOX_GMAIL_CLIENT_ID=from-file\nTEST_MAILBOX_GMAIL_REFRESH_TOKEN="file"\n',
  });
  assert.equal(config.clientId, 'from-env');
  assert.equal(config.refreshToken, 'file');
});

test('dry run lists every message and makes no network calls', async () => {
  const gmail = fakeGmail();
  const lines = [];
  const result = await importDemoMailbox({
    config: loadConfig({ env: {} }),
    messages,
    fetchImpl: gmail.fetchImpl,
    dryRun: true,
    log: line => lines.push(line),
  });
  assert.equal(gmail.calls.length, 0);
  assert.equal(result.dryRun, true);
  assert.equal(lines.length, messages.length + 1);
  assert.ok(lines.some(line => line.includes('Old Lisbon photo walks')));
  assert.match(summarize({ result, total: messages.length }), /Dry run only/);
});

test('imports each message unread into the inbox with the Date header as received time', async () => {
  const gmail = fakeGmail();
  const result = await importDemoMailbox({ config: tokenConfig, messages, fetchImpl: gmail.fetchImpl, log: quiet });
  const imports = gmail.calls.filter(call => call.url.pathname.endsWith('/messages/import'));
  assert.equal(imports.length, messages.length);
  assert.equal(result.imported.length, messages.length);
  assert.equal(result.skipped.length, 0);
  imports.forEach((call, index) => {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer given');
    assert.equal(call.url.searchParams.get('internalDateSource'), 'dateHeader');
    assert.equal(call.url.searchParams.get('neverMarkSpam'), 'true');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body.labelIds, ['INBOX', 'UNREAD']);
    assert.ok(Buffer.from(body.raw, 'base64url').equals(messages[index].raw));
  });
  assert.match(summarize({ result, total: messages.length }), /18 of 18 messages imported/);
});

test('messages already present (by Message-ID) are skipped, so a second run is safe', async () => {
  const present = [messages[0].messageId, messages[16].messageId].map(id => id.slice(1, -1));
  const gmail = fakeGmail({ present });
  const result = await importDemoMailbox({ config: tokenConfig, messages, fetchImpl: gmail.fetchImpl, log: quiet });
  assert.deepEqual(
    result.skipped.map(message => message.file),
    [messages[0].file, messages[16].file],
  );
  assert.equal(result.imported.length, messages.length - 2);
  const searches = gmail.calls.filter(call => call.url.searchParams.has('q'));
  assert.equal(searches.length, messages.length);
  assert.equal(searches[0].url.searchParams.get('includeSpamTrash'), 'true');
  assert.match(summarize({ result, total: messages.length }), /2 already in the mailbox/);

  const again = fakeGmail({ present: messages.map(message => message.messageId.slice(1, -1)) });
  const second = await importDemoMailbox({ config: tokenConfig, messages, fetchImpl: again.fetchImpl, log: quiet });
  assert.equal(second.imported.length, 0);
  assert.ok(!again.calls.some(call => call.url.pathname.endsWith('/messages/import')));
});

test('an access token is minted from the refresh token when none is given', async () => {
  const gmail = fakeGmail();
  const config = loadConfig({
    env: {
      TEST_MAILBOX_GMAIL_CLIENT_ID: 'id',
      TEST_MAILBOX_GMAIL_CLIENT_SECRET: 'secret',
      TEST_MAILBOX_GMAIL_REFRESH_TOKEN: 'refresh',
    },
  });
  await importDemoMailbox({ config, messages: messages.slice(0, 1), fetchImpl: gmail.fetchImpl, log: quiet });
  const tokenCall = gmail.calls[0];
  assert.equal(tokenCall.url.host, 'oauth2.googleapis.com');
  assert.equal(new URLSearchParams(tokenCall.init.body).get('grant_type'), 'refresh_token');
  assert.equal(gmail.calls[1].init.headers.authorization, 'Bearer minted');
});

test('missing credentials and a wrong account stop before anything is imported', async () => {
  const gmail = fakeGmail();
  await assert.rejects(
    importDemoMailbox({ config: loadConfig({ env: {} }), messages, fetchImpl: gmail.fetchImpl, log: quiet }),
    /No Gmail credentials found/,
  );
  const wrong = loadConfig({
    env: { TEST_MAILBOX_GMAIL_ACCESS_TOKEN: 't', TEST_MAILBOX_TO: 'someone.else@example.com' },
  });
  await assert.rejects(
    importDemoMailbox({ config: wrong, messages, fetchImpl: gmail.fetchImpl, log: quiet }),
    /Nothing was imported/,
  );
  assert.ok(!gmail.calls.some(call => call.url.pathname.endsWith('/messages/import')));
});

test('a Gmail error stops the run with the status in the message', async () => {
  const gmail = fakeGmail({ failImportFor: messages[2].messageId });
  await assert.rejects(
    importDemoMailbox({ config: tokenConfig, messages, fetchImpl: gmail.fetchImpl, log: quiet }),
    /HTTP 500/,
  );
  assert.equal(gmail.calls.filter(call => call.url.pathname.endsWith('/messages/import')).length, 3);
});
