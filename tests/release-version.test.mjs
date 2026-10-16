import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  CHANGELOG_PATH,
  DISPLAY_VERSION_PATH,
  compareSemver,
  parseSemver,
  runRelease,
} from '../scripts/release-version.mjs';

const VERSION_SOURCE = `export const APP_DISPLAY_VERSION = '1.0.0';\n`;
const CHANGELOG_SOURCE = '# Changelog\n\n## 2026-09 initial public release\n\nFirst entry.\n';

function fixtureRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'release-version-'));
  const versionFile = join(rootDir, DISPLAY_VERSION_PATH);
  mkdirSync(dirname(versionFile), { recursive: true });
  writeFileSync(versionFile, VERSION_SOURCE);
  writeFileSync(join(rootDir, CHANGELOG_PATH), CHANGELOG_SOURCE);
  return rootDir;
}

test('rejects a version that is not valid semver', () => {
  const rootDir = fixtureRoot();
  try {
    assert.throws(() => runRelease({ rootDir, nextVersion: 'banana', today: '2026-10-16' }), /not a valid semver/);
    assert.throws(() => runRelease({ rootDir, nextVersion: '1.0', today: '2026-10-16' }), /not a valid semver/);
    assert.equal(readFileSync(join(rootDir, DISPLAY_VERSION_PATH), 'utf8'), VERSION_SOURCE);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rejects a lower or equal version', () => {
  const rootDir = fixtureRoot();
  try {
    assert.throws(() => runRelease({ rootDir, nextVersion: '1.0.0', today: '2026-10-16' }), /not higher/);
    assert.throws(() => runRelease({ rootDir, nextVersion: '0.9.9', today: '2026-10-16' }), /not higher/);
    assert.equal(readFileSync(join(rootDir, DISPLAY_VERSION_PATH), 'utf8'), VERSION_SOURCE);
    assert.equal(readFileSync(join(rootDir, CHANGELOG_PATH), 'utf8'), CHANGELOG_SOURCE);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('updates the constant, prepends a dated changelog heading, and prints the tag command', () => {
  const rootDir = fixtureRoot();
  try {
    const result = runRelease({ rootDir, nextVersion: '1.1.0', today: '2026-10-16' });
    assert.equal(result.current, '1.0.0');
    assert.equal(result.next, '1.1.0');
    assert.equal(result.tagCommand, 'git tag v1.1.0');

    const versionSource = readFileSync(join(rootDir, DISPLAY_VERSION_PATH), 'utf8');
    assert.match(versionSource, /export const APP_DISPLAY_VERSION = '1\.1\.0'/);

    const changelog = readFileSync(join(rootDir, CHANGELOG_PATH), 'utf8');
    const headingIndex = changelog.indexOf('## 1.1.0 - 2026-10-16');
    assert.ok(headingIndex > changelog.indexOf('# Changelog'));
    assert.ok(headingIndex < changelog.indexOf('## 2026-09 initial public release'));
    assert.match(changelog, /First entry\./);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('semver precedence handles prereleases', () => {
  assert.deepEqual(parseSemver('1.0.0-alpha')?.prerelease, ['alpha']);
  assert.ok(compareSemver(parseSemver('1.0.0'), parseSemver('1.0.0-alpha')) > 0);
  assert.ok(compareSemver(parseSemver('1.0.0-alpha'), parseSemver('1.0.0-alpha.1')) < 0);
  assert.ok(compareSemver(parseSemver('2.0.0'), parseSemver('1.9.9')) > 0);
  assert.equal(parseSemver('01.0.0'), null);
});
