import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runStatus } from '../../src/commands/status.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { StubProcessRunner, commandLine, okResult, type ProcessResult } from '../../src/runner/processRunner.ts';
import {
  StateBusyError,
  parseRegistry,
  type ReleaseRecord,
  type StateStore,
  type StateSummary,
} from '../../src/state/state.ts';

const RELEASE: ReleaseRecord = {
  schema: '1',
  sourceRef: 'abc123',
  appImage: 'aman-app:abc123',
  sttImage: 'aman-stt:abc123',
  calendarImage: 'aman-calendar-caldav:abc123',
  dexImage: 'ghcr.io/example/dex@sha256:aaaa',
  mailEmailImage: 'ghcr.io/example/mail@sha256:bbbb',
};

function summaryWith(overrides: Partial<StateSummary>): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances: [],
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
    ...overrides,
  };
}

function storeWith(summary: StateSummary): StateStore {
  return {
    readSummary: () => Promise.resolve(summary),
    readCaCertificate: () => Promise.resolve(null),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
    refreshCache: () => undefined,
  };
}

function failingStore(error: Error): StateStore {
  return {
    readSummary: () => Promise.reject(error),
    readCaCertificate: () => Promise.resolve(null),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
    refreshCache: () => undefined,
  };
}

function psLine(name: string): string {
  return commandLine('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=aman-${name}`,
    '--filter',
    'status=running',
  ]);
}

async function run(store: StateStore, runner: StubProcessRunner): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runStatus({
    host: new FakeHost({ kind: 'linux', memoryBytes: 8 * 1024 ** 3 }),
    runner,
    store,
    print: line => {
      lines.push(line);
    },
  });
  return { code, lines };
}

const FAILED: ProcessResult = { exitCode: 1, stdout: '', stderr: 'no docker', started: false };

test('nothing installed prints the not-installed problem and exits 1', async () => {
  const { code, lines } = await run(storeWith(summaryWith({})), new StubProcessRunner(new Map()));
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'Aman is not installed on this computer yet. Install Aman on this computer, then run aman status again.',
  ]);
});

test('a busy state prints the busy problem and exits 1', async () => {
  const { code, lines } = await run(
    failingStore(new StateBusyError('another install is running right now')),
    new StubProcessRunner(new Map()),
  );
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'Another install is running right now. Wait for it to finish, or wait 2 minutes if you stopped an install a moment ago, then run aman status again.',
  ]);
});

test('an unreadable release record prints the unreadable problem and exits 1', async () => {
  const { code, lines } = await run(
    storeWith(summaryWith({ releaseUnreadable: true })),
    new StubProcessRunner(new Map()),
  );
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'The record of what is installed could not be read. Run the installer again from the folder Aman was installed from, then run aman status again.',
  ]);
});

test('installed with no instances says so and exits 0', async () => {
  const { code, lines } = await run(
    storeWith(summaryWith({ release: RELEASE, installedAppImage: 'aman-app:abc123' })),
    new StubProcessRunner(new Map()),
  );
  assert.equal(code, 0);
  assert.deepEqual(lines, ['Aman is installed, version aman-app:abc123.', 'No instance has been made yet.']);
});

test('the installed version falls back to the release record image', async () => {
  const { lines } = await run(storeWith(summaryWith({ release: RELEASE })), new StubProcessRunner(new Map()));
  assert.equal(lines[0], 'Aman is installed, version aman-app:abc123.');
});

test('running, partly running and stopped instances are named with their addresses', async () => {
  const summary = summaryWith({
    release: RELEASE,
    installedAppImage: 'aman-app:abc123',
    instances: [
      { name: 'guest', entries: parseRegistry('name=guest\npublic_url=http://127.0.0.1:8792\n') },
      { name: 'main', entries: parseRegistry('name=main\npublic_url=http://127.0.0.1:8791\n') },
      { name: 'old', entries: parseRegistry('name=old\n') },
    ],
  });
  const answers = new Map<string, ProcessResult>([
    [commandLine('docker', ['ps', '-q']), okResult('')],
    [psLine('main'), okResult('a\nb\nc\n')],
    [psLine('guest'), okResult('a\n')],
    [psLine('old'), okResult('')],
  ]);
  const { code, lines } = await run(storeWith(summary), new StubProcessRunner(answers));
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'Aman is installed, version aman-app:abc123.',
    'Instance guest is partly running at http://127.0.0.1:8792.',
    'Instance main is running at http://127.0.0.1:8791.',
    'Instance old is stopped.',
  ]);
});

test('control characters in a stored address never reach the screen', async () => {
  const summary = summaryWith({
    release: RELEASE,
    instances: [{ name: 'main', entries: [{ key: 'public_url', value: 'http://127.0.0.1:8791\u001b]0;pwned\u0007' }] }],
  });
  const answers = new Map<string, ProcessResult>([
    [commandLine('docker', ['ps', '-q']), okResult('')],
    [psLine('main'), okResult('a\nb\nc\n')],
  ]);
  const { lines } = await run(storeWith(summary), new StubProcessRunner(answers));
  assert.equal(lines.at(-1), 'Instance main is running at http://127.0.0.1:8791]0;pwned.');
  assert.equal(
    lines.some(line => /\p{Cc}/u.test(line)),
    false,
  );
});

test('when Docker does not answer, the problem prints and every instance is unknown', async () => {
  const summary = summaryWith({
    release: RELEASE,
    instances: [{ name: 'main', entries: parseRegistry('name=main\npublic_url=http://127.0.0.1:8791\n') }],
  });
  const answers = new Map<string, ProcessResult>([[commandLine('docker', ['ps', '-q']), FAILED]]);
  const { code, lines } = await run(storeWith(summary), new StubProcessRunner(answers));
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'Aman is installed, version aman-app:abc123.',
    'Docker is not answering, so whether each instance is running is unknown. Start Docker Engine on this computer, then run aman status again.',
    'Instance main: whether it is running is unknown.',
  ]);
});
