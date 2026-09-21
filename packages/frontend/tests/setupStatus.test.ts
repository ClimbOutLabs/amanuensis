import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSetupComplete, mergeSetupRead } from '../src/setupStatus';

test('setup is complete only with a model and a connected or unknown bank', () => {
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: { name: 'amantest', connected: true } }), true);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: undefined }), true);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: null }), false);
  assert.equal(isSetupComplete({ modelName: 'local', memoryBank: { name: 'amantest', connected: false } }), false);
  assert.equal(isSetupComplete({ modelName: null, memoryBank: { name: 'amantest', connected: true } }), false);
  assert.equal(isSetupComplete({ modelName: '  ', memoryBank: { name: 'amantest', connected: true } }), false);
});

test('a failed re-read keeps what was known and a successful one replaces it', () => {
  const previous = { modelName: 'local', memoryBank: { name: 'amantest', connected: true } };
  assert.deepEqual(mergeSetupRead(previous, { modelName: undefined, memoryBank: undefined }), previous);
  assert.deepEqual(mergeSetupRead(previous, { modelName: null, memoryBank: null }), {
    modelName: null,
    memoryBank: null,
  });
  assert.deepEqual(mergeSetupRead(null, { modelName: undefined, memoryBank: undefined }), {
    modelName: null,
    memoryBank: undefined,
  });
});
