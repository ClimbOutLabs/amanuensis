import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleManifests } from '../../src/release/assemble.ts';
import {
  buildManifest,
  manifestToBytes,
  parseManifest,
  type ReleaseManifest,
  type SourceIds,
} from '../../src/release/manifest.ts';

const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};

function part(
  files: readonly { name: string; data: string }[],
  overrides: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  const manifest = buildManifest({
    release: 'v2.0.0',
    files: files.map(file => ({ name: file.name, data: new TextEncoder().encode(file.data) })),
    sourceIds: IDS,
  });
  return { ...manifest, ...overrides };
}

function threeParts(): ReleaseManifest[] {
  return [
    part([
      { name: 'aman-windows-x64.exe', data: 'the windows build' },
      { name: 'amanuensis-v2.0.0.tar.gz', data: 'the source archive' },
    ]),
    part([{ name: 'aman-darwin-arm64', data: 'the mac build' }]),
    part([{ name: 'aman-linux-x64', data: 'the linux build' }]),
  ];
}

test('three partial records assemble into the one release record', () => {
  const result = assembleManifests({ parts: threeParts(), expectedSourceIds: IDS });
  if (!('manifest' in result)) {
    assert.fail(result.problem);
  }
  assert.equal(result.manifest.release, 'v2.0.0');
  assert.deepEqual(Object.keys(result.manifest.files).sort(), [
    'aman-darwin-arm64',
    'aman-linux-x64',
    'aman-windows-x64.exe',
    'amanuensis-v2.0.0.tar.gz',
  ]);
  assert.deepEqual(result.manifest.sourceIds, IDS);
  // The assembled record round-trips through the signed bytes unchanged.
  assert.deepEqual(parseManifest(manifestToBytes(result.manifest)), result.manifest);
});

test('a missing system build refuses loudly', () => {
  const parts = threeParts().slice(0, 2);
  const result = assembleManifests({ parts, expectedSourceIds: IDS });
  if (!('problem' in result)) {
    assert.fail('the assembly should refuse');
  }
  assert.match(result.problem, /Linux build is missing/);
});

test('a missing source archive refuses loudly', () => {
  const parts = [
    part([{ name: 'aman-windows-x64.exe', data: 'the windows build' }]),
    part([{ name: 'aman-darwin-arm64', data: 'the mac build' }]),
    part([{ name: 'aman-linux-x64', data: 'the linux build' }]),
  ];
  const result = assembleManifests({ parts, expectedSourceIds: IDS });
  if (!('problem' in result)) {
    assert.fail('the assembly should refuse');
  }
  assert.match(result.problem, /source archive is missing/);
});

test('two records that disagree about a file refuse loudly', () => {
  const parts = threeParts();
  parts.push(part([{ name: 'aman-linux-x64', data: 'a different linux build' }]));
  const result = assembleManifests({ parts, expectedSourceIds: IDS });
  if (!('problem' in result)) {
    assert.fail('the assembly should refuse');
  }
  assert.match(result.problem, /disagree about the file aman-linux-x64/);
});

test('the same file with the same hash in two records is fine', () => {
  const parts = threeParts();
  parts.push(part([{ name: 'aman-linux-x64', data: 'the linux build' }]));
  const result = assembleManifests({ parts, expectedSourceIds: IDS });
  assert.ok('manifest' in result);
});

test('records for different releases refuse', () => {
  const [windows, mac] = threeParts();
  assert.ok(windows !== undefined && mac !== undefined);
  const other = part([{ name: 'aman-linux-x64', data: 'the linux build' }], { release: 'v2.0.1' });
  const result = assembleManifests({ parts: [windows, mac, other], expectedSourceIds: IDS });
  if (!('problem' in result)) {
    assert.fail('the assembly should refuse');
  }
  assert.match(result.problem, /different releases/);
});

test('a record naming other images than the checkout refuses', () => {
  const [windows, mac] = threeParts();
  assert.ok(windows !== undefined && mac !== undefined);
  const other = part([{ name: 'aman-linux-x64', data: 'the linux build' }], {
    sourceIds: { ...IDS, 'aman-app': 'aman-app:ffffffffffff' },
  });
  const result = assembleManifests({ parts: [windows, mac, other], expectedSourceIds: IDS });
  if (!('problem' in result)) {
    assert.fail('the assembly should refuse');
  }
  assert.match(result.problem, /different images/);
});

test('no partial records refuse', () => {
  const result = assembleManifests({ parts: [], expectedSourceIds: IDS });
  assert.ok('problem' in result);
});
