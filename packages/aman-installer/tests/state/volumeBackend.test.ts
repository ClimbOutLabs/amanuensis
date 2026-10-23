import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  commandLine,
  okBytesResult,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import { createStateStore, parseRegistry, StateBusyError, StateStoreError } from '../../src/state/state.ts';
import { buildTar, parseTar } from '../../src/state/tar.ts';
import { volumeBackend } from '../../src/state/volumeBackend.ts';

const RELEASE_TEXT = `{
  "schema": "1",
  "source_ref": "abc123",
  "app_image": "aman-app:abc123",
  "stt_image": "aman-stt:abc123",
  "calendar_image": "aman-calendar-caldav:abc123",
  "dex_image": "ghcr.io/example/dex@sha256:aaaa",
  "mail_email_image": "ghcr.io/example/mail@sha256:bbbb"
}
`;

// A stand-in for the aman_home volume: a map of files. Reads tar the map
// out, writes unpack the tar they are fed, and every command line is
// recorded for the golden file.
class FakeVolumeRunner implements ProcessRunner {
  readonly lines: string[] = [];
  readonly files = new Map<string, string>();
  writeExitCode = 0;

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.lines.push(commandLine(command, args));
    if (args.includes('ls')) {
      const dir = args[args.length - 1];
      if (dir === '/root/.amanuensis/backups') {
        return Promise.resolve(okResult('20261020T030405Z\n'));
      }
      return Promise.resolve(okResult(''));
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: true });
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    this.lines.push(commandLine(command, args));
    if (args.includes('tar') && args.includes('-c')) {
      const tar = buildTar([...this.files].map(([path, text]) => ({ path, mode: 0o600, text })));
      return Promise.resolve(okBytesResult(tar));
    }
    if (args.includes('sh')) {
      if (this.writeExitCode !== 0) {
        return Promise.resolve({ exitCode: this.writeExitCode, stdout: new Uint8Array(), stderr: '', started: true });
      }
      const incoming = parseTar(stdin);
      for (const [path, text] of incoming) {
        this.files.set(path, text);
      }
      const removeTarget = args[args.length - 1];
      if (typeof removeTarget === 'string' && removeTarget.startsWith('state/') && !args.includes('tar')) {
        this.files.delete(removeTarget);
      }
      return Promise.resolve(okBytesResult(new Uint8Array()));
    }
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: true });
  }
}

function seededRunner(): FakeVolumeRunner {
  const runner = new FakeVolumeRunner();
  runner.files.set('state/instances/main.conf', 'name=main\npublic_url=http://127.0.0.1:8791\n');
  runner.files.set('release/release.json', RELEASE_TEXT);
  runner.files.set('state/installed', '2026-10-20T03:04:05Z aman-app:abc123\n');
  runner.files.set('state/backups', 'daily\n');
  runner.files.set('state/source', '/opt/aman-checkout\n');
  return runner;
}

test('the summary is read out of the volume with one tar read', async () => {
  const runner = seededRunner();
  const store = createStateStore(volumeBackend(runner));
  const summary = await store.readSummary();
  assert.deepEqual(
    summary.instances.map(instance => instance.name),
    ['main'],
  );
  assert.equal(summary.release?.appImage, 'aman-app:abc123');
  assert.deepEqual(summary.backups, ['20261020T030405Z']);
  assert.equal(summary.backupsMode, 'daily');
  assert.equal(summary.installedAppImage, 'aman-app:abc123');
});

test('a write unpacks only the changed file into the volume, under the lock script', async () => {
  const runner = seededRunner();
  const store = createStateStore(volumeBackend(runner));
  await store.readSummary();
  const changed = await store.setInstanceValue({ name: 'main', key: 'healthy', value: '1' });
  assert.equal(changed, true);
  assert.equal(
    runner.files.get('state/instances/main.conf'),
    'name=main\npublic_url=http://127.0.0.1:8791\nhealthy=1\n',
  );
  await store.removeInstance('main');
  assert.equal(runner.files.has('state/instances/main.conf'), false);
});

test('the volume command lines match the golden file', async () => {
  const runner = seededRunner();
  const store = createStateStore(volumeBackend(runner));
  await store.readSummary();
  await store.writeInstance({ name: 'main', entries: parseRegistry('name=main\nhealthy=1\n') });
  await store.removeInstance('main');
  const golden = await readFile(new URL('../golden/status-volume-commands.txt', import.meta.url), 'utf8');
  assert.equal(`${runner.lines.join('\n')}\n`, golden);
});

test('a busy answer from the lock script surfaces as the busy error', async () => {
  const runner = seededRunner();
  runner.writeExitCode = 3;
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(
    store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') }),
    (error: unknown) => error instanceof StateBusyError,
  );
});

test('docker refusing the read surfaces as the state error', async () => {
  const runner = new FakeVolumeRunner();
  runner.runBytes = () => Promise.resolve({ exitCode: 125, stdout: new Uint8Array(), stderr: '', started: true });
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateStoreError);
});
