import { execFile } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandWithWorkspaceLock, workspaceTerminationCommand } from '../../../src/core/sandbox/provider/Provider';

const execFileAsync = promisify(execFile);

// These tests spawn a real shell and depend on the Linux `flock` utility, which
// Git Bash on Windows does not ship. Skip on win32 rather than fail, matching
// provider/workspaceLease.contract.test.ts.
const unixOnly = process.platform === 'win32' ? it.skip : it;

/** Plain directory with no .git: the workspace shape that used to fail closed. */
async function makeNonGitWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'trueforge-nongit-'));
}

describe('workspace locking in non-git workspaces', () => {
  unixOnly('runs a locked command and keeps the lock under .trueforge', async () => {
    const workspaceRoot = await makeNonGitWorkspace();
    const wrapped = commandWithWorkspaceLock({
      sandboxId: 'test',
      command: 'printf hello-locked',
      workspaceLock: { workspaceRoot },
    });
    expect(wrapped.workspaceLock).toBeUndefined();

    const { stdout } = await execFileAsync('sh', ['-c', wrapped.command]);

    expect(stdout).toBe('hello-locked');
    await stat(join(workspaceRoot, '.trueforge', 'trueforge-workspace.lock'));
  });

  unixOnly('coordinates termination state under .trueforge', async () => {
    const workspaceRoot = await makeNonGitWorkspace();

    await execFileAsync('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId: 'op-1' })]);

    const controlDir = join(workspaceRoot, '.trueforge', 'trueforge-evidence-control');
    await stat(join(controlDir, 'op-1.terminated'));
  });

  unixOnly('resolves a relative workspace root against the shell working directory, not the host', async () => {
    const workspaceRoot = await makeNonGitWorkspace();
    // A relative workspace root always equals the exec's cwd at the call
    // sites, so the provider runs the shell with that cwd. The fallback must
    // land under the shell's working directory, not the host's process cwd.
    const wrapped = commandWithWorkspaceLock({
      sandboxId: 'test',
      command: 'printf hello-relative',
      workspaceLock: { workspaceRoot: 'relative-workspace' },
    });

    const { stdout } = await execFileAsync('sh', ['-c', wrapped.command], { cwd: workspaceRoot });

    expect(stdout).toBe('hello-relative');
    await stat(join(workspaceRoot, '.trueforge', 'trueforge-workspace.lock'));
  });
});
