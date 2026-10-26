import pins from '../../../../installer/release.json' with { type: 'json' };
import type { ProcessRunner } from '../runner/processRunner.ts';
import { LOCK_TIMING, type LockTiming } from './lockTiming.ts';
import { StateBusyError, StateDockerError, StateImageError, StateStoreError, type StateBackend } from './state.ts';
import { buildTar, parseTar } from './tar.ts';

// The Windows shape: state lives in the aman_home volume, as the starter
// left it, and each command runs one short-lived container against it.
// The containers mount the volume that holds the install's secrets, so the
// image is pinned by digest. installer/release.json owns the pin, next to
// the other images, so a bump there is the only place it ever changes.
export const SETUP_IMAGE = pins.setup_image;
export const STATE_VOLUME = 'aman_home';
export const VOLUME_HOME = '/root/.amanuensis';

const MOUNT = `${STATE_VOLUME}:${VOLUME_HOME}`;
const MOUNT_READ_ONLY = `${MOUNT}:ro`;

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// The shell installer's lock (common.sh) as one script, followed by the
// command to run under it. installer/STATE.md ("The lock") is the contract:
// the holder refreshes state/lock/beat while it runs, and a lock whose beat
// is older than the dead limit belongs to a holder that stopped. A pid or a
// folder age cannot say that here: the holder ran in its own container, so
// its pid means nothing to this one, and a long install keeps the lock far
// longer than any fixed age.
// Taking over a dead lock first moves the old folder to a name of its own
// (only one run can win that move), checks it really was the dead one, then
// removes it. Exit 3 means another run holds the lock.
export function volumeLockedScript(options: { home: string; command: string; timing?: LockTiming }): string {
  const timing = options.timing ?? LOCK_TIMING;
  const dead = String(timing.deadSeconds);
  // One line, every statement ended with a semicolon: the script is a single command-line argument.
  return [
    `cd ${shellQuote(options.home)} || exit 1;`,
    'mkdir -p state;',
    'chmod 700 state;',
    'beat_age() { b=$(cat "$1/beat" 2>/dev/null); case "$b" in \'\'|*[!0-9]*) return 1 ;; esac; echo $(( $(date +%s) - b )); };',
    // A lock with no beat yet is a holder between mkdir and its first beat, so it is given a moment.
    `is_live() { [ -d "$1" ] || return 1; n=0; while [ "$n" -lt 3 ]; do if a=$(beat_age "$1"); then [ "$a" -lt ${dead} ]; return; fi; n=$((n + 1)); sleep 1; done; return 1; };`,
    'tries=0;',
    'while ! mkdir state/lock 2>/dev/null; do',
    'tries=$((tries + 1));',
    '[ "$tries" -le 5 ] || exit 3;',
    'is_live state/lock && exit 3;',
    'old="state/lock.old.$$.$(date +%s)";',
    'if [ ! -e "$old" ] && mv state/lock "$old" 2>/dev/null; then',
    // The folder moved may be a live lock another run made a moment ago: put it back.
    `if a=$(beat_age "$old") && [ "$a" -lt ${dead} ]; then`,
    'if [ -e state/lock ]; then rm -rf "$old"; else mv "$old" state/lock 2>/dev/null || rm -rf "$old"; fi;',
    'exit 3;',
    'fi;',
    'rm -rf "$old";',
    'fi;',
    'done;',
    'token="$$-$(date +%s)";',
    'beat() { date +%s > "state/lock/beat.$$" && mv -f "state/lock/beat.$$" state/lock/beat; };',
    'printf \'%s\\n\' "$token" > state/lock/owner;',
    'beat;',
    'printf \'%s\\n\' "$$" > state/lock/pid;',
    // The beat stops with the holder, and never touches a lock another run took over.
    `( while sleep ${String(timing.beatSeconds)}; do kill -0 "$$" 2>/dev/null || exit 0; [ "$(cat state/lock/owner 2>/dev/null)" = "$token" ] || exit 0; beat; done ) </dev/null >/dev/null 2>&1 &`,
    'beater=$!;',
    // Only the run that still owns the lock removes it.
    'trap \'kill "$beater" 2>/dev/null; if [ "$(cat state/lock/owner 2>/dev/null)" = "$token" ]; then rm -rf state/lock; fi\' EXIT;',
    options.command,
  ].join(' ');
}

const WRITE_COMMAND = 'tar -x -f -';
const REMOVE_COMMAND = 'rm -f -- "$1"';
const WRITE_SCRIPT = volumeLockedScript({ home: VOLUME_HOME, command: WRITE_COMMAND });
const REMOVE_SCRIPT = volumeLockedScript({ home: VOLUME_HOME, command: REMOVE_COMMAND });

// Docker's own words when the engine is off. Exit 125 alone cannot say so:
// it is also what a failed image pull returns.
const DOCKER_OFF =
  /cannot connect to the docker daemon|error during connect|failed to connect to the docker api|is the docker daemon running/i;

function dockerFailure(result: { started: boolean; exitCode: number; stderr: string }): StateStoreError | null {
  if (!result.started || (result.exitCode !== 0 && DOCKER_OFF.test(result.stderr))) {
    return new StateDockerError('docker did not answer the state command');
  }
  if (result.exitCode === 125) {
    return new StateImageError('docker could not get the helper image for the state volume');
  }
  return null;
}

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
    const failure = dockerFailure(result);
    if (failure !== null) {
      throw failure;
    }
    if (result.exitCode !== 0) {
      throw new StateStoreError('the state volume could not be read');
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
    const failure = dockerFailure(result);
    if (failure !== null) {
      throw failure;
    }
    if (result.exitCode !== 0) {
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
      const failure = dockerFailure(result);
      if (failure !== null) {
        throw failure;
      }
      // A folder the volume does not have yet lists as empty.
      if (result.exitCode !== 0) {
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
