import { GIT_INDEX_ENTRIES_COMMAND, TRACKED_WORKTREE_COMMAND } from '../../../src/core/sandbox/workspaceStateCapture';

/** Fake state-capture output for tracked regular files, keyed by the command that reads it. */
export function fakeTrackedState(
  files: readonly { path: string; indexSha: string; worktreeSha: string }[],
): Record<string, string> {
  return {
    [GIT_INDEX_ENTRIES_COMMAND]: files.map(file => `100644 ${file.indexSha} 0\t${file.path}\0`).join(''),
    [TRACKED_WORKTREE_COMMAND]:
      files.length === 0
        ? ''
        : `${files.map(file => `f\0${file.path}\0\0`).join('')}H\0${files.map(file => `${file.worktreeSha}\n`).join('')}\0`,
  };
}
