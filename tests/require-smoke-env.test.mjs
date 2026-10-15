import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { smokeEnvProblem } from '../scripts/require-smoke-env.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'require-smoke-env.mjs');

function run(cwd) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
}

describe('smoke stack env file', () => {
  it('names the installer in one plain line when the env file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'smoke-env-'));
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim().split('\n').length, 1);
      assert.match(result.stderr, /packages\/trueforge\/\.env does not exist\. To install Aman, run installer\/install\.sh/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent and succeeds when the file exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'smoke-env-'));
    try {
      mkdirSync(path.join(dir, 'packages', 'trueforge'), { recursive: true });
      writeFileSync(path.join(dir, 'packages', 'trueforge', '.env'), 'A=1\n');
      const result = run(dir);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing for an existing file', () => {
    assert.equal(smokeEnvProblem({ exists: true }), undefined);
  });
});
