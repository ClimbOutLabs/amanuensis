/**
 * Self-test for scripts/check-theme-tokens.mjs.
 * Run: node --test scripts/check-theme-tokens.test.mjs
 *
 * Verifies the guard fails on fixed colors (hex + palette class) and passes
 * on theme-token-only source, and that line-scoped allowlist entries exempt
 * only their own line.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'check-theme-tokens.mjs');

function fixtureRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-guard-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runCheck(dir, allowlist = '') {
  // Fixtures never read the repo allowlist, or its line-scoped entries would read as stale.
  writeFileSync(join(dir, 'allowlist.txt'), allowlist);
  try {
    execFileSync(process.execPath, [checker, '--root', dir, '--allowlist', join(dir, 'allowlist.txt')], {
      stdio: 'pipe',
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

test('fails on a fixture with a hex color and a palette class', () => {
  const dir = fixtureRoot({
    'packages/trueforge-ui/src/atoms/Bad.tsx':
      'export const Bad = () => <div className="bg-white text-gray-500" style={{ color: \'#1a1a1a\' }}>x</div>;\n',
  });
  try {
    assert.equal(runCheck(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes on a fixture with only theme token classes', () => {
  const dir = fixtureRoot({
    'packages/trueforge-ui/src/atoms/Good.tsx':
      'export const Good = () => <div className="bg-card-bg text-text-secondary border-border">x</div>;\n',
    'packages/frontend/src/index.css': '.ok { color: var(--text-primary); background: transparent; }\n',
  });
  try {
    assert.equal(runCheck(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails on rgb() literals and named colors', () => {
  const dir = fixtureRoot({
    'packages/frontend/src/bad.css': '.bad { color: rgb(255, 0, 0); background: white; }\n',
  });
  try {
    assert.equal(runCheck(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MATTE_FILE = {
  'packages/trueforge-ui/src/server/matte.ts': "context.fillStyle = '#ffffff';\nconst other = '#123456';\n",
};

test('a line-scoped allowlist entry exempts only the matching line', () => {
  const dir = fixtureRoot(MATTE_FILE);
  try {
    const entry = "packages/trueforge-ui/src/server/matte.ts | context.fillStyle = '#ffffff' :: matte\n";
    assert.equal(runCheck(dir, entry), 1);
    const both = `${entry}packages/trueforge-ui/src/server/matte.ts | const other = '#123456' :: second\n`;
    assert.equal(runCheck(dir, both), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a line-scoped allowlist entry that matches nothing is stale and fails', () => {
  const dir = fixtureRoot({ 'packages/trueforge-ui/src/server/clean.ts': 'export const ok = 1;\n' });
  try {
    assert.equal(runCheck(dir, 'packages/trueforge-ui/src/server/clean.ts | #ffffff :: gone\n'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a whole-file allowlist entry exempts every line of that file', () => {
  const dir = fixtureRoot(MATTE_FILE);
  try {
    assert.equal(runCheck(dir, 'packages/trueforge-ui/src/server/matte.ts :: vendored\n'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
