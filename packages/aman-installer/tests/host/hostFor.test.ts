import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeHost } from '../../src/host/fakeHost.ts';
import { hostForKind, hostForPlatform } from '../../src/host/hostFor.ts';

test('each system name gets its own host', () => {
  assert.equal(hostForPlatform('win32').kind, 'windows');
  assert.equal(hostForPlatform('darwin').kind, 'darwin');
  assert.equal(hostForPlatform('linux').kind, 'linux');
});

test('each kind gets its own host', () => {
  assert.equal(hostForKind('windows').kind, 'windows');
  assert.equal(hostForKind('darwin').kind, 'darwin');
  assert.equal(hostForKind('linux').kind, 'linux');
});

test('the fake host reports the kind and memory it was given', () => {
  const host = new FakeHost({ kind: 'windows', memoryBytes: 1234 });
  assert.equal(host.kind, 'windows');
  assert.equal(host.memoryBytes(), 1234);
});

test('a real host reports memory from this computer', () => {
  assert.ok(hostForPlatform('linux').memoryBytes() > 0);
});
