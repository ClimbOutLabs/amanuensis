import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateBusyError, StateStoreError, type StateBackend } from './state.ts';
import { buildTar, parseTar } from './tar.ts';

// The Windows shape: state lives in the aman_home volume, as the starter
// left it, and each command runs one short-lived container against it.
// SETUP_IMAGE is the image those containers run. The starter builds its
// setup image from this base; the starter spec has not named the setup
// image's own tag or pinned digest, so this is the one place that names
// the image until it does (see the PR body).
export const SETUP_IMAGE = 'docker:cli';
export const STATE_VOLUME = 'aman_home';
export const VOLUME_HOME = '/root/.amanuensis';

const MOUNT = `${STATE_VOLUME}:${VOLUME_HOME}`;
const MOUNT_READ_ONLY = `${MOUNT}:ro`;

// The shell's lock (common.sh) and its write shape, as one script: take
// state/lock or take it over from a dead holder, then unpack the changed
// files from stdin. Exit 3 is the shell's "another install is running".
const LOCK_STEPS = [
  `cd ${VOLUME_HOME} || exit 1`,
  'mkdir -p state',
  'chmod 700 state',
  'if ! mkdir state/lock 2>/dev/null; then pid=$(cat state/lock/pid 2>/dev/null || true); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 3; fi; rm -rf state/lock; mkdir state/lock || exit 1; fi',
  "trap 'rm -rf state/lock' EXIT",
  'printf \'%s\\n\' "$$" > state/lock/pid',
];
const WRITE_SCRIPT = [...LOCK_STEPS, 'tar -x -f -'].join('; ');
const REMOVE_SCRIPT = [...LOCK_STEPS, 'rm -f -- "$1"'].join('; ');

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
    if (!result.started || result.exitCode === 125) {
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
