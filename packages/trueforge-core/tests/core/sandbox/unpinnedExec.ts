import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';

const PINNED_PROGRAM_PREFIX = /'\/usr\/bin\/env' 'PATH=[^']*' (?:'(?:[^']*\/)?([^'\/]+)'|([\w.-]+))/gu;
const GIT_HARDENING_ARGS = / --no-pager --no-optional-locks(?: -c (?:'[^']*'|\S+))+/gu;
const REPOSITORY_CONFIG_PROBE = 'git config --local --no-includes --list --name-only';

/** The bare-name spelling of a host command that Sandbox runs by resolved path, hardened if it is git. */
export function unpinHostCommand(command: string): string {
  return command
    .replace(
      PINNED_PROGRAM_PREFIX,
      (_prefix, resolved: string | undefined, bare: string | undefined) => resolved ?? bare ?? '',
    )
    .replace(GIT_HARDENING_ARGS, '');
}

/** The answer a repository with nothing but plain local settings gives to the config probe. */
export const CLEAN_REPOSITORY_CONFIG: ExecResult = { success: true, response: { exitCode: 0, result: 'core.bare\n' } };

export function isRepositoryConfigProbe(unpinnedCommand: string): boolean {
  return unpinnedCommand === REPOSITORY_CONFIG_PROBE;
}

/** Lets a provider double keep matching host bookkeeping commands by their bare-name spelling. */
export function withUnpinnedCommands(exec: SandboxProvider['exec']): SandboxProvider['exec'] {
  return params => {
    const command = unpinHostCommand(params.command);
    return isRepositoryConfigProbe(command) ? Promise.resolve(CLEAN_REPOSITORY_CONFIG) : exec({ ...params, command });
  };
}
