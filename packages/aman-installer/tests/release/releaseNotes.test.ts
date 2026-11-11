import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CHECKSUMS_ASSET_NAME,
  MANIFEST_ASSET_NAME,
  MANIFEST_SIGNATURE_ASSET_NAME,
  SETUP_ASSET_NAME,
} from '../../src/release/assetNames.ts';
import { releaseNotesText } from '../../src/release/releaseNotes.ts';
import { RELEASE_PUBLIC_KEY_MINISIGN } from '../../src/release/releasePublicKey.ts';

const SECURITY_MD = readFileSync(new URL('../../../../SECURITY.md', import.meta.url), 'utf8');

test('the release page names the release, its files and the key built into Aman', () => {
  const text = releaseNotesText({ release: 'v1.2.3' });
  assert.ok(text.startsWith('## Aman v1.2.3\n'));
  for (const name of [SETUP_ASSET_NAME, MANIFEST_ASSET_NAME, MANIFEST_SIGNATURE_ASSET_NAME, CHECKSUMS_ASSET_NAME]) {
    assert.ok(text.includes(name), name);
  }
  assert.ok(text.includes(`minisign -Vm ${MANIFEST_ASSET_NAME} -P ${RELEASE_PUBLIC_KEY_MINISIGN}`));
  assert.ok(text.includes(`Get-FileHash .\\${SETUP_ASSET_NAME}`));
  assert.ok(text.includes('Windows protected your PC'));
});

test('a stand-in key is the one the page prints', () => {
  const text = releaseNotesText({ release: 'v0.0.1', publicKey: 'RWQstandin' });
  assert.ok(text.includes('-P RWQstandin'));
  assert.ok(!text.includes(RELEASE_PUBLIC_KEY_MINISIGN));
});

// SECURITY.md publishes the key where people can read it; it must be
// the key compiled into Aman, so a changed key fails here until the
// page changes with it.
test('SECURITY.md carries the release key compiled into Aman, and no other', () => {
  assert.ok(SECURITY_MD.includes(RELEASE_PUBLIC_KEY_MINISIGN));
  const keys = SECURITY_MD.match(/\bRW[A-Za-z0-9+/]{54}\b/g) ?? [];
  assert.deepEqual([...new Set(keys)], [RELEASE_PUBLIC_KEY_MINISIGN]);
});
