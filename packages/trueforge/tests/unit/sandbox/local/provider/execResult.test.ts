import type { SessionResult } from '../../../../../src/sandbox/local/core/hostRun';
import { localSandboxExecResult } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

function session(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    stdoutText: '',
    stderrText: '',
    exitCode: 0,
    protocolError: undefined,
    timedOut: false,
    signal: undefined,
    childPid: undefined,
    ...overrides,
  };
}

describe('local sandbox exec result', () => {
  it('reports a signal-terminated command as a failed terminal result', () => {
    expect(localSandboxExecResult(session({ signal: 'SIGKILL' }))).toEqual({
      success: false,
      error: 'Sandbox command terminated by signal SIGKILL',
    });
  });

  it('keeps an ordinary non-zero command exit as a successful provider response', () => {
    expect(localSandboxExecResult(session({ exitCode: 2, stderrText: 'command failed' }))).toEqual({
      success: true,
      response: { exitCode: 2, result: 'command failed' },
    });
  });
});
