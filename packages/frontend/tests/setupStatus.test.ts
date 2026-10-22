import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSetupComplete, mergeSetupRead } from '../src/setupStatus';

test('setup is complete with a model and a first chat or no count', () => {
  assert.equal(isSetupComplete({ modelName: 'local', hasChatted: true }), true);
  assert.equal(isSetupComplete({ modelName: 'local', hasChatted: undefined }), true);
  assert.equal(isSetupComplete({ modelName: 'local', hasChatted: false }), false);
  assert.equal(isSetupComplete({ modelName: null, hasChatted: true }), false);
  assert.equal(isSetupComplete({ modelName: '  ', hasChatted: true }), false);
});

test('a failed re-read keeps what was known and a successful one replaces it', () => {
  const previous = { modelName: 'local', hasChatted: true };
  assert.deepEqual(mergeSetupRead(previous, { modelName: undefined, hasChatted: undefined }), previous);
  assert.deepEqual(mergeSetupRead(previous, { modelName: null, hasChatted: false }), {
    modelName: null,
    hasChatted: false,
  });
  assert.deepEqual(mergeSetupRead(null, { modelName: undefined, hasChatted: undefined }), {
    modelName: null,
    hasChatted: undefined,
  });
});
