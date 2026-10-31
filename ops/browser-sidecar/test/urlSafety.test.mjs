import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNavigationTarget, syntacticallySafeUrl } from '../src/urlSafety.mjs';

test('allows an ordinary https address', () => {
  assert.deepEqual(syntacticallySafeUrl('https://hulu.com/account/cancel').ok, true);
});

test('refuses a file: address', () => {
  assert.deepEqual(syntacticallySafeUrl('file:///etc/passwd'), { ok: false, reason: 'scheme' });
});

test('refuses a chrome: address', () => {
  assert.deepEqual(syntacticallySafeUrl('chrome://settings'), { ok: false, reason: 'scheme' });
});

test('refuses localhost', () => {
  assert.deepEqual(syntacticallySafeUrl('http://localhost:8790/'), { ok: false, reason: 'private_network' });
});

test('refuses a loopback address', () => {
  assert.deepEqual(syntacticallySafeUrl('http://127.0.0.1/'), { ok: false, reason: 'private_network' });
});

test('refuses a router-style private address', () => {
  assert.deepEqual(syntacticallySafeUrl('http://192.168.1.1/'), { ok: false, reason: 'private_network' });
  assert.deepEqual(syntacticallySafeUrl('http://10.0.0.5/'), { ok: false, reason: 'private_network' });
});

test('refuses something that is not a URL at all', () => {
  assert.deepEqual(syntacticallySafeUrl('not a url'), { ok: false, reason: 'not_a_url' });
});

test('safeNavigationTarget refuses a name that resolves to a private address', async () => {
  const result = await safeNavigationTarget('https://internal.example/', {
    resolve: async () => ['10.1.2.3'],
  });
  assert.deepEqual(result, { ok: false, reason: 'private_network' });
});

test('safeNavigationTarget allows a name that resolves to the public internet', async () => {
  const result = await safeNavigationTarget('https://hulu.com/', {
    resolve: async () => ['93.184.216.34'],
  });
  assert.equal(result.ok, true);
});

test('safeNavigationTarget refuses a name that cannot be resolved', async () => {
  const result = await safeNavigationTarget('https://nowhere.invalid/', {
    resolve: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'unresolved' });
});
