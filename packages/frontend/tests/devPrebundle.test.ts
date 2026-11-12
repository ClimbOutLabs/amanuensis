import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEV_OPTIMIZE_DEPS, sourceTreeFingerprint } from '../src/devPrebundle.ts';

function sdkLikeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-fingerprint-'));
  mkdirSync(join(root, 'api', 'types'), { recursive: true });
  writeFileSync(join(root, 'index.ts'), 'export * from "./api/types/Thing";\n');
  writeFileSync(join(root, 'api', 'types', 'Thing.ts'), 'export type Thing = { id: string };\n');
  return root;
}

test('the SDK fingerprint stays the same while nothing under the source changes', () => {
  const root = sdkLikeTree();
  try {
    assert.equal(sourceTreeFingerprint(root), sourceTreeFingerprint(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the SDK fingerprint changes when a nested source file is edited, touched, added or removed', () => {
  const root = sdkLikeTree();
  const nested = join(root, 'api', 'types', 'Thing.ts');
  try {
    const original = sourceTreeFingerprint(root);

    writeFileSync(nested, 'export type Thing = { id: string; name: string };\n');
    const edited = sourceTreeFingerprint(root);
    assert.notEqual(edited, original, 'an edit that changes the size');

    // Same size, new time: a regen that rewrites a file with equal length.
    utimesSync(nested, new Date(2030, 0, 1), new Date(2030, 0, 1));
    const touched = sourceTreeFingerprint(root);
    assert.notEqual(touched, edited, 'a rewrite that keeps the size');

    writeFileSync(join(root, 'api', 'types', 'Other.ts'), 'export type Other = string;\n');
    const added = sourceTreeFingerprint(root);
    assert.notEqual(added, touched, 'a new file');

    rmSync(join(root, 'api', 'types', 'Other.ts'));
    assert.equal(sourceTreeFingerprint(root), touched, 'removing the new file restores the fingerprint');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dev pre-bundle settings carry the SDK fingerprint, so Vite rebuilds a changed SDK', () => {
  const banner = DEV_OPTIMIZE_DEPS.esbuildOptions?.banner?.js;
  assert.match(banner ?? '', /^\/\* trueforge-sdk [0-9a-f]{16} \*\/$/);
  assert.deepEqual(DEV_OPTIMIZE_DEPS.include, ['@truefoundry/trueforge-sdk']);
});
