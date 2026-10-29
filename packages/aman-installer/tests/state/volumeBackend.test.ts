import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import type { LockTiming } from '../../src/state/lockTiming.ts';
import {
  createStateStore,
  parseRegistry,
  StateBusyError,
  StateDockerError,
  StateImageError,
  StateStoreError,
} from '../../src/state/state.ts';
import { buildTar, parseTar } from '../../src/state/tar.ts';
import { SETUP_IMAGE, volumeBackend, volumeLockedScript } from '../../src/state/volumeBackend.ts';

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
// recorded for the golden file. The listings and the tar answer from
// the map the way the real volume answers: a folder with no file under
// it is not there, and tar of a folder that is not there fails.
class FakeVolumeRunner implements ProcessRunner {
  readonly lines: string[] = [];
  readonly files = new Map<string, string>();
  writeExitCode = 0;
  tarExitCode = 0;
  tarStderr = '';

  private namesUnder(prefix: string): string[] {
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      const rest = prefix === '' ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
      if (rest === null) {
        continue;
      }
      const first = rest.split('/')[0];
      if (first !== undefined && first !== '') {
        names.add(first);
      }
    }
    return [...names];
  }

  private folderExists(folder: string): boolean {
    for (const path of this.files.keys()) {
      if (path.startsWith(`${folder}/`)) {
        return true;
      }
    }
    return false;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.lines.push(commandLine(command, args));
    if (args.includes('ls')) {
      const dir = args[args.length - 1];
      if (dir === '/root/.amanuensis/backups') {
        const names = this.namesUnder('backups');
        return Promise.resolve(okResult(names.length === 0 ? '' : `${names.join('\n')}\n`));
      }
      if (dir === '/root/.amanuensis') {
        const names = this.namesUnder('');
        return Promise.resolve(okResult(names.length === 0 ? '' : `${names.join('\n')}\n`));
      }
      return Promise.resolve(okResult(''));
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: true });
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    this.lines.push(commandLine(command, args));
    if (args.includes('cat')) {
      const path = args[args.length - 1];
      const rel = typeof path === 'string' ? path.replace('/root/.amanuensis/', '') : '';
      const text = this.files.get(rel);
      if (text === undefined) {
        return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: 'cat: no such file', started: true });
      }
      return Promise.resolve(okBytesResult(new TextEncoder().encode(text)));
    }
    if (args.includes('tar') && args.includes('-c')) {
      if (this.tarExitCode !== 0) {
        return Promise.resolve({
          exitCode: this.tarExitCode,
          stdout: new Uint8Array(),
          stderr: this.tarStderr,
          started: true,
        });
      }
      const cAt = args.indexOf('-C');
      const requested = cAt === -1 ? [] : args.slice(cAt + 2);
      for (const folder of requested) {
        if (!this.folderExists(folder)) {
          return Promise.resolve({
            exitCode: 2,
            stdout: new Uint8Array(),
            stderr: `tar: ${folder}: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n`,
            started: true,
          });
        }
      }
      const tar = buildTar(
        [...this.files]
          .filter(([path]) => requested.some(folder => path.startsWith(`${folder}/`)))
          .map(([path, text]) => ({ path, mode: 0o600, text })),
      );
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
  runner.files.set('backups/20261020T030405Z/aman-backup.tar', 'fake backup bytes');
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

test('a fresh volume, with neither tree folder in it yet, reads as an empty summary', async () => {
  const runner = new FakeVolumeRunner();
  const store = createStateStore(volumeBackend(runner));
  const summary = await store.readSummary();
  assert.equal(summary.release, null);
  assert.equal(summary.releaseUnreadable, false);
  assert.deepEqual(summary.instances, []);
  assert.deepEqual(summary.backups, []);
  assert.equal(summary.backupsMode, null);
  assert.equal(summary.sourceCheckout, null);
  assert.equal(summary.installedAppImage, null);
});

test('a read after refreshCache sees what an outside writer wrote into the volume', async () => {
  const runner = new FakeVolumeRunner();
  const store = createStateStore(volumeBackend(runner));
  const before = await store.readSummary();
  assert.deepEqual(before.instances, []);
  // A writer outside this process: the shell, in its container,
  // putting an install into the volume behind the store's back. The
  // tree the store already read is a cache, so it cannot see this
  // until the cache is dropped.
  runner.files.set('state/instances/main.conf', 'name=main\npublic_url=http://127.0.0.1:8791\n');
  runner.files.set('release/release.json', RELEASE_TEXT);
  const cached = await store.readSummary();
  assert.deepEqual(cached.instances, []);
  assert.equal(cached.release, null);
  store.refreshCache();
  const after = await store.readSummary();
  assert.deepEqual(
    after.instances.map(instance => instance.name),
    ['main'],
  );
  assert.equal(after.release?.appImage, 'aman-app:abc123');
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
  // The pin lives in installer/release.json, so the golden file names it by a placeholder.
  const lines = runner.lines.map(line => line.replaceAll(SETUP_IMAGE, '<setup image>'));
  assert.equal(`${lines.join('\n')}\n`, golden);
});

const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nfake-certificate-for-tests\n-----END CERTIFICATE-----\n';

test('the authority certificate is read out of the volume on its own, and the key never is', async () => {
  const runner = seededRunner();
  runner.files.set('tls/ca/root.crt', FAKE_CERT);
  runner.files.set('tls/ca/root.key', 'the-key-must-never-leave-the-volume');
  const store = createStateStore(volumeBackend(runner));
  const cert = await store.readCaCertificate();
  assert.equal(cert, FAKE_CERT);
  assert.equal(
    runner.lines.some(line => line.includes('cat /root/.amanuensis/tls/ca/root.crt')),
    true,
  );
  assert.equal(
    runner.lines.some(line => line.includes('root.key')),
    false,
  );
});

test('a volume with no authority yet reads as no certificate', async () => {
  const runner = seededRunner();
  const store = createStateStore(volumeBackend(runner));
  assert.equal(await store.readCaCertificate(), null);
});

test('a certificate read with docker off is the docker error', async () => {
  const store = createStateStore(volumeBackend(failingWith(125, DOCKER_OFF_TEXT)));
  await assert.rejects(store.readCaCertificate(), (error: unknown) => error instanceof StateDockerError);
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

const DOCKER_OFF_TEXT =
  'docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const PULL_FAILED_TEXT =
  'Unable to find image locally\ndocker: Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host.';

function failingWith(exitCode: number, stderr: string): FakeVolumeRunner {
  const runner = new FakeVolumeRunner();
  runner.runBytes = () => Promise.resolve({ exitCode, stdout: new Uint8Array(), stderr, started: true });
  runner.run = () => Promise.resolve({ exitCode, stdout: '', stderr, started: true });
  return runner;
}

test('docker off on the read is the docker error, so status can say to start Docker', async () => {
  const store = createStateStore(volumeBackend(failingWith(125, DOCKER_OFF_TEXT)));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateDockerError);
});

test('docker off on Windows wording is the docker error too', async () => {
  const text =
    'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running';
  const store = createStateStore(volumeBackend(failingWith(1, text)));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateDockerError);
});

test('exit 125 from a failed image download is not read as docker being off', async () => {
  const store = createStateStore(volumeBackend(failingWith(125, PULL_FAILED_TEXT)));
  await assert.rejects(
    store.readSummary(),
    (error: unknown) => error instanceof StateImageError && !(error instanceof StateDockerError),
  );
});

test('a docker command that never starts is the docker error too', async () => {
  const runner = new FakeVolumeRunner();
  runner.runBytes = () => Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  runner.run = () => Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: false });
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(store.readSummary(), (error: unknown) => error instanceof StateDockerError);
});

test('a volume whose folders are there but cannot be read is the plain read error', async () => {
  const runner = seededRunner();
  runner.tarExitCode = 2;
  runner.tarStderr =
    'tar: state/instances/main.conf: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors\n';
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(
    store.readSummary(),
    (error: unknown) =>
      error instanceof StateStoreError &&
      !(error instanceof StateDockerError) &&
      !(error instanceof StateImageError) &&
      !(error instanceof StateBusyError),
  );
});

test('a write with docker off is the docker error, so the next command that writes says to start Docker', async () => {
  const store = createStateStore(volumeBackend(failingWith(125, DOCKER_OFF_TEXT)));
  await assert.rejects(
    store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') }),
    (error: unknown) => error instanceof StateDockerError,
  );
});

test('a write whose image could not be downloaded is the image error', async () => {
  const store = createStateStore(volumeBackend(failingWith(125, PULL_FAILED_TEXT)));
  await assert.rejects(store.removeInstance('main'), (error: unknown) => error instanceof StateImageError);
});

test('a folder listing with docker off is an error, not an empty list', async () => {
  const runner = failingWith(125, DOCKER_OFF_TEXT);
  const backend = volumeBackend(runner);
  await assert.rejects(backend.listNames('backups'), (error: unknown) => error instanceof StateDockerError);
});

test('another failure of the lock script is the plain write error', async () => {
  const runner = seededRunner();
  runner.writeExitCode = 1;
  const store = createStateStore(volumeBackend(runner));
  await assert.rejects(
    store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') }),
    (error: unknown) =>
      error instanceof StateStoreError && !(error instanceof StateBusyError) && !(error instanceof StateDockerError),
  );
});

// The lock tests below run the real script the backend sends, in a plain sh
// against a folder standing in for the volume home. They use no GNU-only
// tool, so they run the same on a Mac. The clock is short (a beat each
// second, dead after three) so a "long" run takes seconds.

const FAST: LockTiming = { beatSeconds: 1, deadSeconds: 3 };
const WRITE = 'tar -x -f -';
const ONE_FILE = [{ path: 'state/instances/main.conf', mode: 0o600, text: 'name=main\n' }];

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aman-volume-lock-'));
}

async function leaveLock(options: { home: string; owner: string; beatAgeSeconds: number | null }): Promise<string> {
  const lockDir = join(options.home, 'state', 'lock');
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'pid'), '1\n');
  if (options.owner !== '') {
    await writeFile(join(lockDir, 'owner'), `${options.owner}\n`);
  }
  if (options.beatAgeSeconds !== null) {
    await writeFile(join(lockDir, 'beat'), `${String(Math.floor(Date.now() / 1000) - options.beatAgeSeconds)}\n`);
  }
  return lockDir;
}

function runScript(options: { home: string; command: string; input?: Uint8Array; env?: NodeJS.ProcessEnv }) {
  return spawnSync('sh', ['-c', volumeLockedScript({ home: options.home, command: options.command, timing: FAST })], {
    input: Buffer.from(options.input ?? new Uint8Array()),
    env: options.env ?? process.env,
  });
}

function startScript(options: { home: string; command: string }) {
  const child = spawn(
    'sh',
    ['-c', volumeLockedScript({ home: options.home, command: options.command, timing: FAST })],
    {
      stdio: 'ignore',
    },
  );
  const exited = new Promise<number | null>(resolve => {
    child.on('close', code => {
      resolve(code);
    });
  });
  return { child, exited };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

test('the script uses no tool the Mac lacks', () => {
  const script = volumeLockedScript({ home: '/h', command: WRITE });
  assert.equal(/\bstat\b/.test(script), false);
});

test('the real script refuses a lock with a fresh beat, whatever its pid says', async () => {
  const home = await freshHome();
  const lockDir = await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 0 });
  const result = runScript({ home, command: WRITE, input: buildTar(ONE_FILE) });
  assert.equal(result.status, 3, result.stderr.toString());
  assert.equal((await readFile(join(lockDir, 'owner'), 'utf8')).trim(), 'other-run');
  await assert.rejects(readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'));
});

test('the real script takes over a lock whose beat stopped, even one holding the pid of a crashed container', async () => {
  const home = await freshHome();
  const lockDir = await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 3600 });
  const result = runScript({ home, command: WRITE, input: buildTar(ONE_FILE) });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
  await assert.rejects(access(lockDir));
});

test('the real script takes over a lock a crash left with no beat at all', async () => {
  const home = await freshHome();
  await leaveLock({ home, owner: '', beatAgeSeconds: null });
  const result = runScript({ home, command: WRITE, input: buildTar(ONE_FILE) });
  assert.equal(result.status, 0, result.stderr.toString());
});

test('the real remove script also takes over a lock whose beat stopped', async () => {
  const home = await freshHome();
  await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 3600 });
  await mkdir(join(home, 'state', 'instances'), { recursive: true });
  await writeFile(join(home, 'state', 'instances', 'main.conf'), 'name=main\n');
  const result = spawnSync('sh', [
    '-c',
    volumeLockedScript({ home, command: 'rm -f -- "$1"', timing: FAST }),
    'sh',
    'state/instances/main.conf',
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  await assert.rejects(access(join(home, 'state', 'instances', 'main.conf')));
});

test('a holder that keeps beating keeps its lock long past the dead limit', async () => {
  const home = await freshHome();
  const holder = startScript({ home, command: 'sleep 7' });
  await pause(5000);
  const second = runScript({ home, command: WRITE, input: buildTar(ONE_FILE) });
  assert.equal(second.status, 3, 'a lock older than the dead limit that still beats is busy');
  assert.equal(await holder.exited, 0);
  await assert.rejects(access(join(home, 'state', 'lock')));
});

test('a holder killed without cleanup stops beating, and its lock is then taken over', async () => {
  const home = await freshHome();
  const holder = startScript({ home, command: 'sleep 6' });
  await pause(1500);
  holder.child.kill('SIGKILL');
  await holder.exited;
  await pause(5000);
  const second = runScript({ home, command: WRITE, input: buildTar(ONE_FILE) });
  assert.equal(second.status, 0, second.stderr.toString());
});

test('a holder whose lock was taken over leaves the new holder lock in place', async () => {
  const home = await freshHome();
  const takeover = 'rm -rf state/lock; mkdir state/lock; echo new-run > state/lock/owner; date +%s > state/lock/beat';
  const result = runScript({ home, command: takeover });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal((await readFile(join(home, 'state', 'lock', 'owner'), 'utf8')).trim(), 'new-run');
});

test('a live lock moved aside by mistake is put back and the run is told it is busy', async () => {
  const home = await freshHome();
  await leaveLock({ home, owner: 'old-run', beatAgeSeconds: 3600 });
  // A stand-in mv that, on the first move of the lock, lets another run take it over first.
  const bin = await mkdtemp(join(tmpdir(), 'aman-volume-bin-'));
  const realMv = spawnSync('sh', ['-c', 'command -v mv']).stdout.toString().trim();
  const marker = join(bin, 'raced');
  await writeFile(
    join(bin, 'mv'),
    [
      '#!/bin/sh',
      `if [ "$1" = state/lock ] && [ ! -e '${marker}' ]; then`,
      `  : > '${marker}'`,
      '  rm -rf state/lock; mkdir state/lock; echo other-run > state/lock/owner; date +%s > state/lock/beat',
      'fi',
      `exec '${realMv}' "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'mv'), 0o755);
  const result = runScript({
    home,
    command: WRITE,
    input: buildTar(ONE_FILE),
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
  assert.equal(result.status, 3, result.stderr.toString());
  assert.equal((await readFile(join(home, 'state', 'lock', 'owner'), 'utf8')).trim(), 'other-run');
});

// The takeover has to be safe when several runs find the same stopped
// holder's lock together, so these start real runs at the same moment.

function startWrite(home: string) {
  const child = spawn('sh', ['-c', volumeLockedScript({ home, command: WRITE })]);
  child.stdin.on('error', () => undefined);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => {
      resolve({ status, stderr });
    });
  });
  return { child, done };
}

for (const [label, owner] of [
  ['a lock with an owner', 'other-run'],
  ['a lock a crash left with no owner', ''],
] as const) {
  test(`when many runs find ${label} whose beat stopped together, exactly one writes and the rest are told another install is running`, async () => {
    const writers = 6;
    for (let round = 0; round < 8; round += 1) {
      const home = await freshHome();
      await leaveLock({ home, owner, beatAgeSeconds: 3600 });
      const runs = Array.from({ length: writers }, () => startWrite(home));
      // The winner waits at its input while it holds the lock, so the losers leave on their own.
      let exited = 0;
      const tracked = runs.map(async run => {
        const result = await run.done;
        exited += 1;
        return result;
      });
      for (let waited = 0; exited < writers - 1; waited += 1) {
        if (waited > 600) {
          runs.forEach(run => run.child.kill());
          assert.fail(`round ${String(round)} did not settle`);
        }
        await pause(25);
      }
      runs.forEach(run => run.child.stdin.end(Buffer.from(buildTar(ONE_FILE))));
      const results = await Promise.all(tracked);
      const codes = results.map(result => result.status).sort((a, b) => (a ?? -1) - (b ?? -1));
      assert.deepEqual(
        codes,
        [0, ...Array.from({ length: writers - 1 }, () => 3)],
        `round ${String(round)}: ${results.map(result => result.stderr).join(' | ')}`,
      );
      assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
      await assert.rejects(access(join(home, 'state', 'lock')));
    }
  });
}
