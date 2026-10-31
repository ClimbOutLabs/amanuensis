import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

const execFileAsync = promisify(execFile);

const FIXTURE_HOME = new URL('../fixtures/state-home', import.meta.url).pathname;
const GOLDEN_SUMMARY = new URL('../fixtures/state-summary.json', import.meta.url).pathname;
const DOCTOR = new URL('../../../../installer/doctor/aman', import.meta.url).pathname;

async function goldenSummary(): Promise<unknown> {
  return JSON.parse(await readFile(GOLDEN_SUMMARY, 'utf8'));
}

test('the folder reader gives the golden summary for the fixture home', async () => {
  // The golden pins the summary's fields. The backup times and
  // the schedule record's time are this backend's own file times, so the
  // copy's times are pinned first and those fields are checked apart.
  const copy = await mkdtemp(join(tmpdir(), 'aman-fixture-'));
  const homeCopy = join(copy, 'home');
  await cp(FIXTURE_HOME, homeCopy, { recursive: true });
  const backupOneTime = 1_800_000_000;
  const backupTwoTime = 1_800_086_400;
  const modeTime = 1_800_100_000;
  await utimes(
    join(homeCopy, 'backups', '20261020T030405Z'),
    new Date(backupOneTime * 1000),
    new Date(backupOneTime * 1000),
  );
  await utimes(
    join(homeCopy, 'backups', '20261021T030405Z-keep'),
    new Date(backupTwoTime * 1000),
    new Date(backupTwoTime * 1000),
  );
  await utimes(join(homeCopy, 'state', 'backups'), new Date(modeTime * 1000), new Date(modeTime * 1000));
  const store = createStateStore(folderBackend(homeCopy));
  const { backupEntries, backupsModeTimeSeconds, certificateAuthority, ...shared } = await store.readSummary();
  assert.deepEqual(shared, await goldenSummary());
  assert.deepEqual(backupEntries, [
    { name: '20261020T030405Z', timeSeconds: backupOneTime },
    { name: '20261021T030405Z-keep', timeSeconds: backupTwoTime },
  ]);
  assert.equal(backupsModeTimeSeconds, modeTime);
  assert.deepEqual(certificateAuthority, {
    certPresent: true,
    keyMode: null,
    fingerprint: null,
    fingerprintHasContent: false,
  });
  // The certificate itself is read on its own, apart from the summary.
  const expectedCert = await readFile(join(FIXTURE_HOME, 'tls', 'ca', 'root.crt'), 'utf8');
  assert.equal(await store.readCaCertificate(), expectedCert);
});

test('the shell doctor names the same instances as the reader, from the same home', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'aman-fixture-'));
  const homeCopy = join(copy, 'home');
  await cp(FIXTURE_HOME, homeCopy, { recursive: true });
  const store = createStateStore(folderBackend(FIXTURE_HOME));
  const summary = await store.readSummary();
  const result = await execFileAsync('bash', [DOCTOR, 'doctor', '--json', '--local'], {
    env: { ...process.env, AMANUENSIS_HOME: homeCopy },
    timeout: 60000,
  }).catch((error: unknown) => {
    // The doctor exits 1 when a check fails (Docker is absent here); its
    // JSON on stdout is what this test reads.
    if (typeof error === 'object' && error !== null && 'stdout' in error) {
      const stdout = error.stdout;
      if (typeof stdout === 'string') {
        return { stdout };
      }
    }
    throw error;
  });
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== 'object' || parsed === null || !('instances' in parsed)) {
    throw new Error('the doctor output has no instances document');
  }
  const instances = parsed.instances;
  if (typeof instances !== 'object' || instances === null) {
    throw new Error('the doctor instances document is not an object');
  }
  assert.deepEqual(
    Object.keys(instances).sort(),
    summary.instances.map(instance => instance.name),
  );
});

