import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StateStoreError } from '../../src/state/state.ts';
import { buildTar, parseTar } from '../../src/state/tar.ts';

test('a built tar parses back to the same files', () => {
  const bytes = buildTar([
    { path: 'state/instances/main.conf', mode: 0o600, text: 'name=main\napp_port=8791\n' },
    { path: 'release/release.json', mode: 0o600, text: '{\n  "schema": "1"\n}\n' },
    { path: 'state/source', mode: 0o600, text: '/opt/aman-checkout\n' },
  ]);
  const files = parseTar(bytes);
  assert.equal(files.size, 3);
  assert.equal(files.get('state/instances/main.conf'), 'name=main\napp_port=8791\n');
  assert.equal(files.get('release/release.json'), '{\n  "schema": "1"\n}\n');
  assert.equal(files.get('state/source'), '/opt/aman-checkout\n');
});

test('folder entries are not returned as files', () => {
  const bytes = buildTar([{ path: 'state/instances/main.conf', mode: 0o600, text: 'name=main\n' }]);
  const files = parseTar(bytes);
  assert.deepEqual([...files.keys()], ['state/instances/main.conf']);
});

test('an empty stream parses to no files', () => {
  assert.equal(parseTar(new Uint8Array()).size, 0);
  assert.equal(parseTar(buildTar([])).size, 0);
});

test('a stream that ends partway still gives back the files that arrived', () => {
  const bytes = buildTar([
    { path: 'state/source', mode: 0o600, text: '/opt/aman-checkout\n' },
    { path: 'release/release.json', mode: 0o600, text: '{}\n' },
  ]);
  // Cut the stream inside the second file's header.
  const cut = bytes.subarray(0, bytes.length - 1600);
  const files = parseTar(cut);
  assert.equal(files.get('state/source'), '/opt/aman-checkout\n');
  assert.equal(files.has('release/release.json'), false);
});

test('file text with multi-byte characters survives the round trip', () => {
  const bytes = buildTar([{ path: 'state/instances/main.conf', mode: 0o600, text: 'owner_name=André\n' }]);
  assert.equal(parseTar(bytes).get('state/instances/main.conf'), 'owner_name=André\n');
});

test('a file name too long for the header is refused', () => {
  const longPath = `state/${'a'.repeat(120)}.conf`;
  assert.throws(() => buildTar([{ path: longPath, mode: 0o600, text: 'x' }]));
});

test('a name too long in bytes, though short in characters, is refused', () => {
  const longPath = `state/${'é'.repeat(50)}.conf`;
  assert.ok(longPath.length < 100);
  assert.throws(() => buildTar([{ path: longPath, mode: 0o600, text: 'x' }]));
});

test('a stream with a negative size stops with an error instead of looping', () => {
  const bytes = buildTar([{ path: 'state/source', mode: 0o600, text: 'x\n' }]);
  // Rewrite the size field (offset 124, 12 bytes) of the file header to a negative number.
  const damaged = bytes.slice();
  damaged.set(new TextEncoder().encode('-00000000512\0'), 124 + 512);
  assert.throws(() => parseTar(damaged), StateStoreError);
});
