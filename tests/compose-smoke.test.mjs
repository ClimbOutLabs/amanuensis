import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';

import { SMOKE_SECRETS, smokeComposeEnv } from '../scripts/compose-smoke.mjs';

describe('the smoke stack secrets', () => {
  it('covers the calendar and browser secrets', () => {
    assert.deepEqual(SMOKE_SECRETS, ['CALENDAR_ACCOUNT_SECRET', 'BROWSER_SECRET']);
  });

  it('makes a random secret of 32 or more characters for each one not set, and leaves the rest alone', () => {
    const env = smokeComposeEnv({ env: { PATH: '/usr/bin' } });
    assert.equal(env.PATH, '/usr/bin');
    for (const name of SMOKE_SECRETS) {
      assert.ok(env[name].length >= 32, name);
    }
    assert.notEqual(env.CALENDAR_ACCOUNT_SECRET, env.BROWSER_SECRET);
  });

  it('makes a different secret each time', () => {
    const first = smokeComposeEnv({ env: {} });
    const second = smokeComposeEnv({ env: {} });
    for (const name of SMOKE_SECRETS) {
      assert.notEqual(first[name], second[name], name);
    }
  });

  it('keeps a secret that is already set, so a stack started by hand can be stopped the same way', () => {
    const env = {
      CALENDAR_ACCOUNT_SECRET: 'already-set-secret-0123456789abcdef0123',
      BROWSER_SECRET: 'already-set-browser-0123456789abcdef0123',
    };
    assert.deepEqual(smokeComposeEnv({ env }), env);
  });

  it('treats a blank value as not set', () => {
    const env = smokeComposeEnv({ env: { CALENDAR_ACCOUNT_SECRET: '  ', BROWSER_SECRET: '' } });
    for (const name of SMOKE_SECRETS) {
      assert.ok(env[name].trim().length >= 32, name);
    }
  });

  it('is what the smoke scripts run, and the compose file holds no fixed default for any of them', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
    assert.match(scripts.smoke, /compose-smoke\.mjs up/);
    assert.match(scripts['smoke:down'], /compose-smoke\.mjs down/);
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    const calendar = compose.split('\n').filter(line => line.includes('CALENDAR_ACCOUNT_SECRET:'));
    assert.equal(calendar.length, 2);
    const browser = compose.split('\n').filter(line => line.includes('BROWSER_SECRET:'));
    assert.equal(browser.length, 2);
    for (const line of [...calendar, ...browser]) {
      assert.match(line, /\$\{(CALENDAR_ACCOUNT_SECRET|BROWSER_SECRET):\?/, line);
      assert.ok(!line.includes(':-'), line);
    }
  });
});
