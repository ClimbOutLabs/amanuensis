import type { ExecResult, SandboxExecParams } from '../../../src/core/sandbox/provider/Provider';
import { withTrustedPath } from '../../../src/core/sandbox/provider/Provider';

const TRUSTED_PATH_PREFIX = withTrustedPath('');

/** The command a fake provider should match on, without the host's fixed-PATH prefix. */
export function realCommand(command: string): string {
  return command.startsWith(TRUSTED_PATH_PREFIX) ? command.slice(TRUSTED_PATH_PREFIX.length) : command;
}

/** Wraps a fake provider `exec` so host-authored commands reach it exactly as written. */
export function realCommandExec(
  exec: (params: SandboxExecParams) => Promise<ExecResult>,
): (params: SandboxExecParams) => Promise<ExecResult> {
  return params => exec({ ...params, command: realCommand(params.command) });
}
