import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  commandLine,
  okBytesResult,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import {
  createStateStore,
  parseRegistry,
  StateBusyError,
  StateDockerError,
  StateStoreError,
} from '../../src/state/state.ts';
import { buildTar, parseTar } from '../../src/state/tar.ts';
import { volumeBackend, volumeRemoveScript, volumeWriteScript } from '../../src/state/volumeBackend.ts';

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

test('docker refusing the read is the docker error, so status can say to start Docker', async () => {
  const runner = new FakeVolumeRunner();
  runner.runBytes = () => Promise.resolve({ exitCode: 125, stdout: new Uint8Array(), stderr: '', started: true });
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateDockerError);
});

test('a docker command that never starts is the docker error too', async () => {
  const runner = new FakeVolumeRunner();
  runner.runBytes = () => Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateDockerError);
});

// The lock tests below run the real script the backend sends, against a
// folder standing in for the volume home, because the lock's judgement
// (the folder's age, not the pid) only exists inside that script.

async function homeWithLock(ageSeconds: number, pidText: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'aman-volume-lock-'));
  await mkdir(join(home, 'state', 'lock'), { recursive: true });
  await writeFile(join(home, 'state', 'lock', 'pid'), pidText);
  const when = new Date(Date.now() - ageSeconds * 1000);
  await utimes(join(home, 'state', 'lock'), when, when);
  return home;
}

const ONE_FILE = [{ path: 'state/instances/main.conf', mode: 0o600, text: 'name=main\n' }];

test('the real write script refuses a lock that was just taken, whatever its pid says', async () => {
  const home = await homeWithLock(0, '999999\n');
  const result = spawnSync('sh', ['-c', volumeWriteScript(home)], { input: Buffer.from(buildTar(ONE_FILE)) });
  assert.equal(result.status, 3, result.stderr.toString());
  await assert.rejects(readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'));
});

test('the real write script takes over a lock left by a dead holder, even one naming a live pid', async () => {
  const home = await homeWithLock(3600, `${String(process.pid)}\n`);
  const result = spawnSync('sh', ['-c', volumeWriteScript(home)], { input: Buffer.from(buildTar(ONE_FILE)) });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
  await assert.rejects(access(join(home, 'state', 'lock')));
});

test('the real write script takes over the lock a crashed run left, whose pid reads as alive here', async () => {
  const home = await homeWithLock(3600, '1\n');
  const result = spawnSync('sh', ['-c', volumeWriteScript(home)], { input: Buffer.from(buildTar(ONE_FILE)) });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
});

test('the real remove script also takes over a dead holder lock', async () => {
  const home = await homeWithLock(3600, '1\n');
  await mkdir(join(home, 'state', 'instances'), { recursive: true });
  await writeFile(join(home, 'state', 'instances', 'main.conf'), 'name=main\n');
  const result = spawnSync('sh', ['-c', volumeRemoveScript(home), 'sh', 'state/instances/main.conf']);
  assert.equal(result.status, 0, result.stderr.toString());
  await assert.rejects(access(join(home, 'state', 'instances', 'main.conf')));
});

// The takeover tests below start real runs of the script at the same
// moment, because the takeover only has to be safe when several runs find
// the same dead holder's lock together.

interface RunningWrite {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ status: number | null; stderr: string }>;
}

// A write run left blocked on its input, the way a run holds the lock
// while it works: the script takes the lock first, then reads the tar
// from stdin, so a run whose stdin never closes is a run still holding.
function startWrite(home: string): RunningWrite {
  const child = spawn('sh', ['-c', volumeWriteScript(home)]);
  child.stdin.on('error', () => undefined);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ status, stderr }));
  });
  return { child, done };
}

async function lockToken(home: string): Promise<string> {
  try {
    return (await readFile(join(home, 'state', 'lock', 'token'), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('when many runs find a dead holder lock together, exactly one writes and the rest are told another install is running', async () => {
  const writers = 6;
  const rounds = 10;
  for (let round = 0; round < rounds; round += 1) {
    const home = await homeWithLock(3600, '1\n');
    const runs = Array.from({ length: writers }, () => startWrite(home));
    // The losers leave on their own with exit 3; whoever holds the lock
    // waits at its input. Wait for the round to settle before feeding
    // anyone, so a second run can never slip in after the winner has
    // finished and count as a second success.
    let exited = 0;
    const tracked = runs.map(run =>
      run.done.then(result => {
        exited += 1;
        return result;
      }),
    );
    try {
      await waitFor(async () => exited >= writers - 1, 'the round to settle');
    } catch (error) {
      for (const run of runs) {
        run.child.kill();
      }
      throw error;
    }
    for (const run of runs) {
      run.child.stdin.end(Buffer.from(buildTar(ONE_FILE)));
    }
    const results = await Promise.all(tracked);
    const codes = results.map(result => result.status).sort((a, b) => (a ?? -1) - (b ?? -1));
    assert.deepEqual(
      codes,
      [0, ...Array.from({ length: writers - 1 }, () => 3)],
      `round ${String(round)}: ${results.map(result => result.stderr).join(' | ')}`,
    );
    assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
    assert.equal((await readdir(join(home, 'state'))).includes('lock'), false);
  }
});

test('a holder whose lock was taken over cannot take the new holder lock away when it exits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aman-volume-lock-'));
  const first = startWrite(home);
  let second: RunningWrite | undefined;
  try {
    await waitFor(async () => (await lockToken(home)) !== '', 'the first run to take the lock');
    const firstToken = await lockToken(home);
    // The first run is still going, but its lock now reads as a dead
    // holder's: old enough that a second run may take it over.
    const when = new Date(Date.now() - 3600 * 1000);
    await utimes(join(home, 'state', 'lock'), when, when);
    second = startWrite(home);
    const secondRun = second;
    await waitFor(async () => {
      const token = await lockToken(home);
      return token !== '' && token !== firstToken;
    }, 'the second run to take the lock over');
    const secondToken = await lockToken(home);
    first.child.stdin.end();
    await first.done;
    assert.equal(await lockToken(home), secondToken);
    secondRun.child.stdin.end();
    await secondRun.done;
    await assert.rejects(access(join(home, 'state', 'lock')));
  } finally {
    first.child.kill();
    second?.child.kill();
  }
});
