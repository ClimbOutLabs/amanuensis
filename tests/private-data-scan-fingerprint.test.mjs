import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/private-data-scan.py', import.meta.url));
const salt = 'test-salt';
const fingerprint = text => createHash('sha256').update(`${salt}:${text}`).digest('hex');

function scan(content) {
  const root = mkdtempSync(join(tmpdir(), 'aman-fingerprint-scan-'));
  try {
    const fingerprints = join(root, 'fingerprints.json');
    writeFileSync(fingerprints, JSON.stringify({ salt, hashes: [fingerprint('zorblax'), fingerprint('quenby tarvish')] }));
    const target = join(root, 'target');
    spawnSync('mkdir', [target]);
    writeFileSync(join(target, 'notes.txt'), content);
    return spawnSync('python3', ['-I', scanner, target], {
      encoding: 'utf8',
      env: { ...process.env, PRIVATE_DATA_FINGERPRINTS: fingerprints },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('flags a hashed single word regardless of case and punctuation', () => {
  const result = scan('hello, ZORBLAX!\n');
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /zorblax/iu);
});

test('flags a hashed word pair only when the tokens are consecutive', () => {
  assert.equal(scan('Quenby   Tarvish\n').status, 1);
  assert.equal(scan('quenby and tarvish\n').status, 0);
});

test('passes text without hashed words', () => {
  assert.equal(scan('nothing to see here\n').status, 0);
});
