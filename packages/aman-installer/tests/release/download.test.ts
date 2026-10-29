import assert from 'node:assert/strict';
import { test } from 'node:test';

import { problemText, VERIFY_SIGNATURE_BAD, verifyChangedProblem } from '../../src/messages.ts';
import {
  fetchLatestManifest,
  fetchReleaseFile,
  sourceArchiveName,
  windowsAssetName,
  type FetchBytes,
} from '../../src/release/download.ts';
import { buildManifest, manifestToBytes, type SourceIds } from '../../src/release/manifest.ts';
import { signMinisign } from '../../src/release/minisign.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from './testKeys.ts';

const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};
const BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';
const EXE_BYTES = new TextEncoder().encode('the windows build');
const ARCHIVE_BYTES = new TextEncoder().encode('the source archive');

function releaseTable(): Map<string, Uint8Array> {
  const manifest = buildManifest({
    release: 'v2.0.0',
    files: [
      { name: 'aman-windows-x64.exe', data: EXE_BYTES },
      { name: 'amanuensis-v2.0.0.tar.gz', data: ARCHIVE_BYTES },
    ],
    sourceIds: IDS,
  });
  const bytes = manifestToBytes(manifest);
  const signature = signMinisign({ data: bytes, privateKeyDer: testPrivateKeyDer(), keyNum: testKeyNum() });
  return new Map<string, Uint8Array>([
    [`${BASE}/latest/download/manifest.json`, bytes],
    [`${BASE}/latest/download/manifest.json.minisig`, new TextEncoder().encode(signature)],
    [`${BASE}/download/v2.0.0/aman-windows-x64.exe`, EXE_BYTES],
    [`${BASE}/download/v2.0.0/amanuensis-v2.0.0.tar.gz`, ARCHIVE_BYTES],
  ]);
}

function fetcher(table: Map<string, Uint8Array>, seen: string[]): FetchBytes {
  return (url: string) => {
    seen.push(url);
    return Promise.resolve(table.get(url) ?? null);
  };
}

test('the newest release record is fetched from latest and checked', async () => {
  const seen: string[] = [];
  const result = await fetchLatestManifest({
    fetchBytes: fetcher(releaseTable(), seen),
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  assert.deepEqual(seen, [`${BASE}/latest/download/manifest.json`, `${BASE}/latest/download/manifest.json.minisig`]);
  if (!('manifest' in result)) {
    assert.fail('the record should check out');
  }
  assert.equal(result.manifest.release, 'v2.0.0');
});

test('a record whose signature fails is refused with its problem', async () => {
  const table = releaseTable();
  const bytes = table.get(`${BASE}/latest/download/manifest.json`);
  assert.ok(bytes !== undefined);
  const tampered = new Uint8Array(bytes);
  tampered[20] = tampered[20] === 65 ? 66 : 65;
  table.set(`${BASE}/latest/download/manifest.json`, tampered);
  const result = await fetchLatestManifest({
    fetchBytes: fetcher(table, []),
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  if (!('problem' in result)) {
    assert.fail('the record should be refused');
  }
  assert.equal(problemText(result.problem), problemText(VERIFY_SIGNATURE_BAD));
});

test('a release page that does not answer is unreachable, not a refusal', async () => {
  const result = await fetchLatestManifest({
    fetchBytes: () => Promise.resolve(null),
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  assert.deepEqual(result, { unreachable: true });
});

test('a release file comes from the record release and is checked against it', async () => {
  const seen: string[] = [];
  const fetchBytes = fetcher(releaseTable(), seen);
  const latest = await fetchLatestManifest({ fetchBytes, publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN });
  if (!('manifest' in latest)) {
    assert.fail('the record should check out');
  }
  const file = await fetchReleaseFile({ fetchBytes, manifest: latest.manifest, name: 'aman-windows-x64.exe' });
  assert.deepEqual(seen[seen.length - 1], `${BASE}/download/v2.0.0/aman-windows-x64.exe`);
  if (!('data' in file)) {
    assert.fail('the file should check out');
  }
  assert.deepEqual(file.data, EXE_BYTES);
});

test('a release file that does not match the record is refused', async () => {
  const table = releaseTable();
  table.set(`${BASE}/download/v2.0.0/aman-windows-x64.exe`, new TextEncoder().encode('another build'));
  const fetchBytes = fetcher(table, []);
  const latest = await fetchLatestManifest({ fetchBytes, publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN });
  if (!('manifest' in latest)) {
    assert.fail('the record should check out');
  }
  const file = await fetchReleaseFile({ fetchBytes, manifest: latest.manifest, name: 'aman-windows-x64.exe' });
  if (!('problem' in file)) {
    assert.fail('the file should be refused');
  }
  assert.equal(problemText(file.problem), problemText(verifyChangedProblem('aman-windows-x64.exe')));
});

test('the source archive is the one archive the record names', () => {
  const manifest = buildManifest({
    release: 'v2.0.0',
    files: [
      { name: 'aman-windows-x64.exe', data: EXE_BYTES },
      { name: 'amanuensis-v2.0.0.tar.gz', data: ARCHIVE_BYTES },
    ],
    sourceIds: IDS,
  });
  assert.equal(sourceArchiveName(manifest), 'amanuensis-v2.0.0.tar.gz');
  const bare = buildManifest({
    release: 'v2.0.0',
    files: [{ name: 'aman-windows-x64.exe', data: EXE_BYTES }],
    sourceIds: IDS,
  });
  assert.equal(sourceArchiveName(bare), null);
});

test('the windows asset name follows the release naming', () => {
  assert.equal(windowsAssetName('x64'), 'aman-windows-x64.exe');
  assert.equal(windowsAssetName('arm64'), 'aman-windows-arm64.exe');
});
