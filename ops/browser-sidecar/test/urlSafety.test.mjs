import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateAddress, safeNavigationTarget, syntacticallySafeUrl } from '../src/urlSafety.mjs';

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

test('treats IPv4-mapped, tunnel and bracketed IPv6 forms as private', () => {
  for (const address of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '[::1]',
    '2002:c0a8:0101::1',
    '2001:0:4136:e378::1',
    'fe80::1',
    'fd00::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test('treats ordinary public addresses as public', () => {
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('treats anything that is not an address as private', () => {
  assert.equal(isPrivateAddress('example.com'), true);
  assert.equal(isPrivateAddress(''), true);
});

test('refuses an IPv6 literal for loopback in a URL', () => {
  assert.deepEqual(syntacticallySafeUrl('http://[::1]:8790/'), { ok: false, reason: 'private_network' });
  assert.deepEqual(syntacticallySafeUrl('http://[::ffff:127.0.0.1]/'), { ok: false, reason: 'private_network' });
});

test('safeNavigationTarget refuses a name that resolves to a mapped loopback address', async () => {
  const result = await safeNavigationTarget('https://mapped.example/', { resolve: async () => ['::ffff:127.0.0.1'] });
  assert.deepEqual(result, { ok: false, reason: 'private_network' });
});

test('safeNavigationTarget refuses localhost written with a trailing dot', async () => {
  const result = await safeNavigationTarget('http://localhost./', { resolve: async () => ['93.184.216.34'] });
  assert.deepEqual(result, { ok: false, reason: 'private_network' });
});

test('refuses documentation, benchmarking and relay ranges, which are never a real site', () => {
  for (const address of ['192.0.2.10', '198.51.100.7', '203.0.113.1', '192.88.99.1', '255.255.255.255', '3fff::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});
