import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateBusyError, StateDockerError, StateStoreError, type StateBackend } from './state.ts';
import { buildTar, parseTar } from './tar.ts';

// The Windows shape: state lives in the aman_home volume, as the starter
// left it, and each command runs one short-lived container against it.
// SETUP_IMAGE is the image those containers run, pinned by digest so the
// image cannot change under its tag: the containers it starts mount the
// volume that holds the install's secrets. The starter builds its setup
// image from this base; this is the one place that names the image.
export const SETUP_IMAGE = 'docker:cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb';
export const STATE_VOLUME = 'aman_home';
export const VOLUME_HOME = '/root/.amanuensis';

const MOUNT = `${STATE_VOLUME}:${VOLUME_HOME}`;
const MOUNT_READ_ONLY = `${MOUNT}:ro`;

// How long a lock in the volume counts as held, in seconds. A write under
// this lock unpacks a few small files and takes seconds, so a lock older
// than this is one whose holder stopped without removing it.
const LOCK_STALE_SECONDS = 900;

// The lock folder's age evidence: when it was last changed, in seconds.
const LOCK_TIME = 'stat -c %Y state/lock 2>/dev/null';

// The shell's lock folder and write shape, as one script: take state/lock
// or take it over from a dead holder, then do the write. Exit 3 is the
// shell's "another install is running". On a host folder the pid decides
// whether the holder is alive (folderLock.ts), but in the volume the
// holder ran inside its own short-lived container, whose shell is process
// 1, so the pid it wrote names that container's processes and says
// nothing about whether the holder is still running; a leftover lock's
// pid 1 would read as alive inside every later container, forever. The
// lock folder's age is the evidence that works here, because the holder
// and the checker read the same clock: younger than LOCK_STALE_SECONDS is
// a run still going, and older is a holder that died. The pid file is
// still written, as the lock keeps it. The trap removes the folder only
// while its stamp is still the one this run took, so a holder whose lock
// was taken over cannot remove the new holder's lock when it finally
// exits.
function lockSteps(home: string): readonly string[] {
  return [
    `cd ${home} || exit 1`,
    'mkdir -p state',
    'chmod 700 state',
    `if ! mkdir state/lock 2>/dev/null; then taken=$(${LOCK_TIME}); now=$(date +%s); if [ -z "$taken" ] || [ $((now - taken)) -lt ${String(LOCK_STALE_SECONDS)} ]; then exit 3; fi; rm -rf state/lock; mkdir state/lock || exit 1; fi`,
    'printf \'%s\\n\' "$$" > state/lock/pid',
    `stamp=$(${LOCK_TIME})`,
    `trap 'if [ "$(${LOCK_TIME})" = "$stamp" ]; then rm -rf state/lock; fi' EXIT`,
  ];
}

export function volumeWriteScript(home: string): string {
  return [...lockSteps(home), 'tar -x -f -'].join('; ');
}

export function volumeRemoveScript(home: string): string {
  return [...lockSteps(home), 'rm -f -- "$1"'].join('; ');
}

const WRITE_SCRIPT = volumeWriteScript(VOLUME_HOME);
const REMOVE_SCRIPT = volumeRemoveScript(VOLUME_HOME);

export function volumeBackend(runner: ProcessRunner): StateBackend {
  let files: Map<string, string> | null = null;

  const readTree = async (): Promise<Map<string, string>> => {
    if (files !== null) {
      return files;
    }
    const result = await runner.runBytes(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        MOUNT_READ_ONLY,
        SETUP_IMAGE,
        'tar',
        '-c',
        '-f',
        '-',
        '-C',
        VOLUME_HOME,
        'state',
        'release',
      ],
      new Uint8Array(),
    );
    // Exit 125 is docker itself refusing the run, and a run that never
    // started means the docker command is not there: either way Docker
    // did not answer, which the status command reports as its own
    // problem (start Docker), not as an unreadable record.
    if (!result.started || result.exitCode === 125) {
      throw new StateDockerError('docker did not answer the state read');
    }
    files = parseTar(result.stdout);
    return files;
  };

  const runLocked = async (script: string, extraArgs: readonly string[], stdin: Uint8Array): Promise<void> => {
    const result = await runner.runBytes(
      'docker',
      ['run', '--rm', '--network', 'none', '-i', '-v', MOUNT, SETUP_IMAGE, 'sh', '-c', script, ...extraArgs],
      stdin,
    );
    if (result.exitCode === 3) {
      throw new StateBusyError('another install is running right now');
    }
    if (!result.started || result.exitCode !== 0) {
      throw new StateStoreError('the state volume could not be written');
    }
    files = null;
  };

  return {
    readText: async path => {
      const tree = await readTree();
      return tree.get(path) ?? null;
    },
    listNames: async dir => {
      if (dir.startsWith('state/') || dir.startsWith('release/')) {
        const tree = await readTree();
        const prefix = `${dir}/`;
        const names = new Set<string>();
        for (const path of tree.keys()) {
          if (path.startsWith(prefix)) {
            const rest = path.slice(prefix.length);
            const first = rest.split('/')[0];
            if (first !== undefined && first !== '') {
              names.add(first);
            }
          }
        }
        return [...names];
      }
      const result = await runner.run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        MOUNT_READ_ONLY,
        SETUP_IMAGE,
        'ls',
        '-1',
        `${VOLUME_HOME}/${dir}`,
      ]);
      if (!result.started || result.exitCode !== 0) {
        return [];
      }
      return result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
    },
    writeChangedFiles: async changed => {
      const tar = buildTar(changed.map(file => ({ path: file.path, mode: 0o600, text: file.text })));
      await runLocked(WRITE_SCRIPT, [], tar);
    },
    removeFile: async path => {
      await runLocked(REMOVE_SCRIPT, ['sh', path], new Uint8Array());
    },
  };
}
