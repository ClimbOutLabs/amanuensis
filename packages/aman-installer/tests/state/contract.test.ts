import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore, renderRelease } from '../../src/state/state.ts';

const execFileAsync = promisify(execFile);

const FIXTURE_HOME = new URL('../fixtures/state-home', import.meta.url).pathname;
const GOLDEN_SUMMARY = new URL('../fixtures/state-summary.json', import.meta.url).pathname;
const RELEASE_PINS = new URL('../../../../installer/release.json', import.meta.url).pathname;
const RELEASE_SCHEMA = new URL('../../../../installer/release.schema.json', import.meta.url).pathname;
const DOCTOR = new URL('../../../../installer/doctor/aman', import.meta.url).pathname;
const INSTALLER_LIB = new URL('../../../../installer/lib', import.meta.url).pathname;

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

// The schema's own rules, for the flat string records it describes: every key is one it names,
// the required keys are there, and each value is a string that meets its const and pattern.
function schemaProblems({ record, schema }: { record: unknown; schema: unknown }): string[] {
  assert.ok(typeof schema === 'object' && schema !== null && 'properties' in schema && 'required' in schema);
  const { properties, required } = schema;
  assert.ok(typeof properties === 'object' && properties !== null && Array.isArray(required));
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return ['not an object'];
  }
  const rules = new Map(Object.entries(properties));
  const problems: string[] = [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in record)) {
      problems.push(`missing ${key}`);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const rule: unknown = rules.get(key);
    if (typeof rule !== 'object' || rule === null) {
      problems.push(`unknown ${key}`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${key} is not a string`);
      continue;
    }
    if ('const' in rule && value !== rule.const) {
      problems.push(`${key} is not ${String(rule.const)}`);
    }
    if ('pattern' in rule && typeof rule.pattern === 'string' && !new RegExp(rule.pattern).test(value)) {
      problems.push(`${key} does not match its pattern`);
    }
  }
  return problems;
}

test('the pins, a record the shell writes and a record this program writes all meet the release schema', async () => {
  const schema: unknown = JSON.parse(await readFile(RELEASE_SCHEMA, 'utf8'));
  const pins: unknown = JSON.parse(await readFile(RELEASE_PINS, 'utf8'));
  assert.deepEqual(schemaProblems({ record: pins, schema }), [], 'installer/release.json');
  assert.ok(typeof pins === 'object' && pins !== null && 'dex_image' in pins && 'mail_email_image' in pins);
  const releaseDir = await mkdtemp(join(tmpdir(), 'aman-release-record-'));
  const script = [
    '. "$1/common.sh"',
    '. "$1/release.sh"',
    'RELEASE_DIR=$2',
    'REL_REF=0123456789abcdef0123456789abcdef01234567',
    'REL_APP_TAG=aman-app:0123456789ab',
    'REL_STT_TAG=aman-stt:0123456789ab',
    'REL_CALENDAR_TAG=aman-calendar-caldav:0123456789ab',
    'REL_BROWSER_TAG=aman-browser:0123456789ab',
    'REL_BROWSER_GATEWAY_TAG=aman-browser-gateway:0123456789ab',
    'REL_DEX_IMAGE=$3',
    'REL_MAIL_EMAIL_IMAGE=$4',
    'release_write',
  ].join('\n');
  await execFileAsync('bash', [
    '-c',
    script,
    'release-write',
    INSTALLER_LIB,
    releaseDir,
    String(pins.dex_image),
    String(pins.mail_email_image),
  ]);
  const written: unknown = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'));
  assert.deepEqual(schemaProblems({ record: written, schema }), [], 'the record release.sh writes');
  assert.ok(typeof written === 'object' && written !== null && 'browser_image' in written);
  const rendered: unknown = JSON.parse(
    renderRelease({
      schema: '1',
      sourceRef: 'abc123',
      appImage: 'aman-app:abc123',
      sttImage: 'aman-stt:abc123',
      calendarImage: 'aman-calendar-caldav:abc123',
      browserImage: 'aman-browser:abc123',
      browserGatewayImage: 'aman-browser-gateway:abc123',
      dexImage: String(pins.dex_image),
      mailEmailImage: String(pins.mail_email_image),
    }),
  );
  assert.deepEqual(schemaProblems({ record: rendered, schema }), [], 'the record this program writes');
});
