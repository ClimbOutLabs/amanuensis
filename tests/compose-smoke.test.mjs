import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';

import { smokeComposeEnv } from '../scripts/compose-smoke.mjs';

describe('the smoke stack calendar secret', () => {
  it('makes a random secret of 32 or more characters when none is set, and leaves the rest alone', () => {
    const env = smokeComposeEnv({ env: { PATH: '/usr/bin' } });
    assert.equal(env.PATH, '/usr/bin');
    assert.ok(env.CALENDAR_ACCOUNT_SECRET.length >= 32);
  });

  it('makes a different secret each time', () => {
    const first = smokeComposeEnv({ env: {} }).CALENDAR_ACCOUNT_SECRET;
    const second = smokeComposeEnv({ env: {} }).CALENDAR_ACCOUNT_SECRET;
    assert.notEqual(first, second);
  });

  it('keeps a secret that is already set, so a stack started by hand can be stopped the same way', () => {
    const env = { CALENDAR_ACCOUNT_SECRET: 'already-set-secret-0123456789abcdef0123' };
    assert.equal(smokeComposeEnv({ env }).CALENDAR_ACCOUNT_SECRET, env.CALENDAR_ACCOUNT_SECRET);
  });

  it('treats a blank value as not set', () => {
    assert.ok(smokeComposeEnv({ env: { CALENDAR_ACCOUNT_SECRET: '  ' } }).CALENDAR_ACCOUNT_SECRET.trim().length >= 32);
  });

  it('is what the smoke scripts run, and the compose file holds no fixed default for it', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
    assert.match(scripts.smoke, /compose-smoke\.mjs up/);
    assert.match(scripts['smoke:down'], /compose-smoke\.mjs down/);
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    const lines = compose.split('\n').filter(line => line.includes('CALENDAR_ACCOUNT_SECRET:'));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(line.includes('${CALENDAR_ACCOUNT_SECRET:?'), line);
      assert.ok(!line.includes(':-'), line);
    }
  });
});
