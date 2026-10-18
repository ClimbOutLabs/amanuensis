import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSetupComplete, mergeSetupRead } from '../src/setupStatus';

test('setup is complete only with a model, a connected or unknown bank, and a first chat or no count', () => {
  const bank = { name: 'amantest', connected: true };
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: bank, hasChatted: true }), true);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: bank, hasChatted: undefined }), true);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: bank, hasChatted: false }), false);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: undefined, hasChatted: true }), true);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: null, hasChatted: true }), false);
  assert.equal(
    isSetupComplete({ modelName: 'local', memoryBank: { ...bank, connected: false }, hasChatted: true }),
    false,
  );
  assert.equal(isSetupComplete({ modelName: null, memoryBank: bank, hasChatted: true }), false);
  assert.equal(isSetupComplete({ modelName: '  ', memoryBank: bank, hasChatted: true }), false);
});

test('a failed re-read keeps what was known and a successful one replaces it', () => {
  const previous = { modelName: 'local', memoryBank: { name: 'amantest', connected: true }, hasChatted: true };
  assert.deepEqual(
    mergeSetupRead(previous, { modelName: undefined, memoryBank: undefined, hasChatted: undefined }),
    previous,
  );
  assert.deepEqual(mergeSetupRead(previous, { modelName: null, memoryBank: null, hasChatted: false }), {
    modelName: null,
    memoryBank: null,
    hasChatted: false,
  });
  assert.deepEqual(mergeSetupRead(null, { modelName: undefined, memoryBank: undefined, hasChatted: undefined }), {
    modelName: null,
    memoryBank: undefined,
    hasChatted: undefined,
  });
});
