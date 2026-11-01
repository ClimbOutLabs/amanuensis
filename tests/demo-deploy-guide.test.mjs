import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guide = readFileSync(path.join(rootDir, 'demo', 'deploy-nebius.md'), 'utf8');
const installer = readFileSync(path.join(rootDir, 'installer', 'install.sh'), 'utf8');

test('the deploy guide documents no flag the installer refuses', () => {
  assert.doesNotMatch(guide, /--demo-user/);
  const demoSection = guide.slice(guide.indexOf('## 4. The demo world'), guide.indexOf("### Maya's mailbox"));
  const flags = [...new Set(demoSection.match(/--[a-z][a-z-]*/g))];
  assert.ok(flags.length > 0, 'the demo section names at least one flag');
  for (const flag of flags) {
    assert.ok(installer.includes(flag), `${flag} is in the installer, so the guide may name it`);
  }
});
