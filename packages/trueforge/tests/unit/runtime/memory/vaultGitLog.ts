import type { HostCommandRunner } from '@truefoundry/trueforge-core/core/sandbox/slots/git/hostCommand';

import { vaultGitArgv, vaultGitEnv } from '../../../../src/runtime/memory/vaultGit';

/** A vault's newest commits, newest first, read with the same no-shell git call the vault uses. */
export async function vaultLog({
  vaultDir,
  runner,
  limit,
}: {
  vaultDir: string;
  runner: HostCommandRunner;
  limit: number;
}): Promise<{ sha: string; subject: string }[]> {
  const result = await runner.run({
    argv: vaultGitArgv({ vaultDir, args: ['log', '--format=%H%x00%s', '-n', String(limit)] }),
    env: vaultGitEnv(vaultDir),
    cwd: vaultDir,
    timeoutMs: 30_000,
    signal: undefined,
    maxStdoutBytes: 1_000_000,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .toString('utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const separator = line.indexOf('\0');
      return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
}
