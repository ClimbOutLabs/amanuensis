import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(rootDir, 'demo', 'scripts', 'send-test-mailbox.mjs');
const manifest = JSON.parse(readFileSync(path.join(rootDir, 'demo', 'fixtures', 'mailbox', 'demo-set.json'), 'utf8'));

test('dry run lists exactly the demo set, nothing outside it', () => {
  const output = execFileSync(process.execPath, [script, '--dry-run'], { cwd: rootDir, encoding: 'utf8' });
  const listed = output
    .split('\n')
    .filter(line => line.startsWith('  '))
    .map(line => line.trim().split(' | ')[0]);
  assert.deepEqual(
    listed,
    manifest.files.map(({ file }) => file),
  );
});
