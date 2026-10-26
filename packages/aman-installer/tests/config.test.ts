import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installerConfig } from '../src/config.ts';

test('the state home defaults to .amanuensis in the home folder', () => {
  assert.equal(installerConfig({ env: {}, homeDir: '/home/person' }).stateHome, '/home/person/.amanuensis');
});

test('AMANUENSIS_HOME names the state home when it is set', () => {
  assert.equal(
    installerConfig({ env: { AMANUENSIS_HOME: '/data/aman' }, homeDir: '/home/person' }).stateHome,
    '/data/aman',
  );
});

test('an empty AMANUENSIS_HOME is treated as not set', () => {
  assert.equal(
    installerConfig({ env: { AMANUENSIS_HOME: '' }, homeDir: '/home/person' }).stateHome,
    '/home/person/.amanuensis',
  );
});
