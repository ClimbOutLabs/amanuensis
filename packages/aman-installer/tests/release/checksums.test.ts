import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { checksumsText } from '../../src/release/checksums.ts';

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('the checksums list every file sorted by name in the sha256sum format', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const text = checksumsText([
    { name: 'manifest.json', data: encode('the record') },
    { name: 'Aman-Setup.exe', data: encode('the windows build') },
    { name: 'aman-linux-x64', data: encode('the linux build') },
  ]);
  assert.equal(
    text,
    `${hashOf('the windows build')}  Aman-Setup.exe\n` +
      `${hashOf('the linux build')}  aman-linux-x64\n` +
      `${hashOf('the record')}  manifest.json\n`,
  );
});

test('no files make an empty list', () => {
  assert.equal(checksumsText([]), '');
});
