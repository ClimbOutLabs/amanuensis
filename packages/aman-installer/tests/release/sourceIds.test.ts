import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERIFY_SOURCE_IDS_MISMATCH, problemText } from '../../src/messages.ts';
import { buildManifest } from '../../src/release/manifest.ts';
import { installerLibDir, sourceIdsFromCheckout } from '../../src/release/sourceIds.ts';
import { checkSourceIds } from '../../src/release/verify.ts';
import { SystemProcessRunner } from '../../src/runner/processRunner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

// A small clean clone standing in for a release checkout: the shell's
// own source_id is the oracle, and the manifest must carry its answer.
function fixtureClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aman-installer-source-ids-'));
  git(dir, ['init', '-q']);
  mkdirSync(join(dir, 'ops', 'aman-stt'), { recursive: true });
  mkdirSync(join(dir, 'ops', 'calendar-sidecar'), { recursive: true });
  writeFileSync(join(dir, 'Dockerfile.dev'), 'FROM node\n');
  writeFileSync(join(dir, 'ops', 'aman-stt', 'Dockerfile'), 'FROM python\n');
  writeFileSync(join(dir, 'ops', 'calendar-sidecar', 'Dockerfile'), 'FROM node\n');
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'fixture']);
  return dir;
}

test('the manifest source ids equal the shell source_id of the same clone', async () => {
  const clone = fixtureClone();
  const ids = await sourceIdsFromCheckout({
    runner: new SystemProcessRunner(),
    checkoutDir: clone,
    libDir: installerLibDir(repoRoot),
  });
  assert.ok(ids !== null);
  const head = git(clone, ['rev-parse', 'HEAD']).slice(0, 12);
  const stt = git(clone, ['rev-parse', 'HEAD:ops/aman-stt']).slice(0, 12);
  const calendar = git(clone, ['rev-parse', 'HEAD:ops/calendar-sidecar']).slice(0, 12);
  assert.deepEqual(ids, {
    'aman-app': `aman-app:${head}`,
    'aman-stt': `aman-stt:${stt}`,
    'aman-calendar-caldav': `aman-calendar-caldav:${calendar}`,
  });
  const manifest = buildManifest({ release: 'v1.2.3', files: [], sourceIds: ids });
  assert.equal(checkSourceIds({ manifest, expected: ids }), null);
  const problem = checkSourceIds({
    manifest,
    expected: { ...ids, 'aman-calendar-caldav': 'aman-calendar-caldav:ffffffffffff' },
  });
  assert.ok(problem !== null);
  assert.equal(problemText(problem), problemText(VERIFY_SOURCE_IDS_MISMATCH));
});
