import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { StubProcessRunner, commandLine, okBytesResult, okResult } from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';
import { buildTar } from '../../src/state/tar.ts';
import { SETUP_IMAGE, STATE_VOLUME, VOLUME_HOME, volumeBackend } from '../../src/state/volumeBackend.ts';

const execFileAsync = promisify(execFile);

const FIXTURE_HOME = new URL('../fixtures/state-home', import.meta.url).pathname;
const GOLDEN_SUMMARY = new URL('../fixtures/state-summary.json', import.meta.url).pathname;
const RELEASE_PINS = new URL('../../../../installer/release.json', import.meta.url).pathname;
const RELEASE_SCHEMA = new URL('../../../../installer/release.schema.json', import.meta.url).pathname;
const DOCTOR = new URL('../../../../installer/doctor/aman', import.meta.url).pathname;

// Every file under the fixture home, as volume-relative paths with text.
async function fixtureFiles(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), path);
      } else {
        files.push({ path, text: await readFile(join(dir, entry.name), 'utf8') });
      }
    }
  };
  await walk(FIXTURE_HOME, '');
  return files;
}

async function goldenSummary(): Promise<unknown> {
  return JSON.parse(await readFile(GOLDEN_SUMMARY, 'utf8'));
}

test('the folder reader gives the golden summary for the fixture home', async () => {
  const store = createStateStore(folderBackend(FIXTURE_HOME));
  assert.deepEqual(await store.readSummary(), await goldenSummary());
});

test('the volume reader gives the same summary for the same fixture, packed as a tar', async () => {
  const all = await fixtureFiles();
  // The volume read tars only state/ and release/, as the backend does.
  const tarred = all
    .filter(file => file.path.startsWith('state/') || file.path.startsWith('release/'))
    .map(file => ({ path: file.path, mode: 0o600, text: file.text }));
  const readLine = commandLine('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}:ro`,
    SETUP_IMAGE,
    'tar',
    '-c',
    '-f',
    '-',
    '-C',
    VOLUME_HOME,
    'state',
    'release',
  ]);
  const backupNames = all
    .filter(file => file.path.startsWith('backups/'))
    .map(file => file.path.split('/')[1])
    .filter((name): name is string => name !== undefined);
  const lsLine = commandLine('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}:ro`,
    SETUP_IMAGE,
    'ls',
    '-1',
    `${VOLUME_HOME}/backups`,
  ]);
  const runner = new StubProcessRunner(
    new Map([[lsLine, okResult(`${[...new Set(backupNames)].join('\n')}\n`)]]),
    new Map([[readLine, okBytesResult(buildTar(tarred))]]),
  );
  const store = createStateStore(volumeBackend(runner));
  assert.deepEqual(await store.readSummary(), await goldenSummary());
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

const DIGEST_PIN = /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

test('the setup image is the digest pin in installer/release.json, which the schema names', async () => {
  const pins: unknown = JSON.parse(await readFile(RELEASE_PINS, 'utf8'));
  const schema: unknown = JSON.parse(await readFile(RELEASE_SCHEMA, 'utf8'));
  assert.ok(typeof pins === 'object' && pins !== null && 'setup_image' in pins);
  assert.equal(SETUP_IMAGE, pins.setup_image);
  assert.match(SETUP_IMAGE, DIGEST_PIN);
  assert.ok(typeof schema === 'object' && schema !== null && 'properties' in schema);
  assert.ok(typeof schema.properties === 'object' && schema.properties !== null && 'setup_image' in schema.properties);
});
