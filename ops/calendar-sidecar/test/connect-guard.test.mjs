import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'connect-guard.mjs');

// Runs a script in a fresh node with the guard loaded the way the tool server loads it.
function withGuard(script) {
  return execFileSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', script], {
    encoding: 'utf8',
  }).trim();
}

describe('the address guard in the tool server', () => {
  it('refuses a connection to a name that points at this computer', () => {
    const answer = withGuard(`
      import { request } from 'node:https';
      request('https://localhost:4443/').on('error', error => console.log(error.code)).end();
    `);
    assert.equal(answer, 'EAI_FAIL');
  });

  it('refuses the same name through fetch, which the tool server uses', () => {
    const answer = withGuard(`
      fetch('https://localhost:4443/').catch(error => console.log(error.cause?.code));
    `);
    assert.equal(answer, 'EAI_FAIL');
  });

  // The real lookup is replaced before the guard loads, so the answers come from the test.
  function lookupWith(entries, options) {
    return execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import dns from 'node:dns';
        dns.lookup = (_host, _options, callback) => callback(null, ${JSON.stringify(entries)});
        await import(${JSON.stringify(pathToFileURL(GUARD).href)});
        dns.lookup('calendar.example.invalid', ${JSON.stringify(options)}, (error, address, family) =>
          console.log(JSON.stringify(error === null ? { address, family } : { code: error.code })));
        `,
      ],
      { encoding: 'utf8' },
    ).trim();
  }

  it('passes a public address through, in the shape the caller asked for', () => {
    const entries = [{ address: '93.184.216.34', family: 4 }];
    assert.deepEqual(JSON.parse(lookupWith(entries, {})), { address: '93.184.216.34', family: 4 });
    assert.deepEqual(JSON.parse(lookupWith(entries, { all: true })), { address: entries });
  });

  it('refuses a name when any one of its addresses is forbidden', () => {
    const entries = [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    assert.deepEqual(JSON.parse(lookupWith(entries, { all: true })), { code: 'EAI_FAIL' });
  });
});
