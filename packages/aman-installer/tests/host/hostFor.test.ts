import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeHost } from '../../src/host/fakeHost.ts';
import { hostForKind, hostForPlatform } from '../../src/host/hostFor.ts';

test('each system name gets its own host', () => {
  assert.equal(hostForPlatform('darwin').kind, 'darwin');
  assert.equal(hostForPlatform('linux').kind, 'linux');
});

test('an unknown system name is treated as linux, the family the installer supports', () => {
  assert.equal(hostForPlatform('win32').kind, 'linux');
});

test('each kind gets its own host', () => {
  assert.equal(hostForKind('darwin').kind, 'darwin');
  assert.equal(hostForKind('linux').kind, 'linux');
});

test('the fake host reports the kind and memory it was given', () => {
  const host = new FakeHost({ kind: 'linux', memoryBytes: 1234 });
  assert.equal(host.kind, 'linux');
  assert.equal(host.memoryBytes(), 1234);
});

test('a real host reports memory from this computer', () => {
  assert.ok(hostForPlatform('linux').memoryBytes() > 0);
});
