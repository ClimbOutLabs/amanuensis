jest.mock('../../../../../src/sandbox/local/core/hostRun', () => {
  const actual = jest.requireActual<typeof import('../../../../../src/sandbox/local/core/hostRun')>(
    '../../../../../src/sandbox/local/core/hostRun',
  );
  return {
    ...actual,
    initSrt: jest.fn(),
    removeSandbox: jest.fn(actual.removeSandbox),
    resetSrt: jest.fn(),
    runSupervisorSession: jest.fn(),
  };
});

jest.mock('../../../../../src/sandbox/local/core/CodeModeUdsTransport', () => {
  const actual = jest.requireActual<typeof import('../../../../../src/sandbox/local/core/CodeModeUdsTransport')>(
    '../../../../../src/sandbox/local/core/CodeModeUdsTransport',
  );
  return {
    ...actual,
    assertCodeModeSocketParentPath: jest.fn(),
  };
});

jest.mock('ulid', () => ({
  ...jest.requireActual<typeof import('ulid')>('ulid'),
  ulid: jest.fn(),
}));

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from 'winston';
import * as codeMode from '../../../../../src/sandbox/local/core/CodeModeUdsTransport';
import * as hostRun from '../../../../../src/sandbox/local/core/hostRun';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

const { runSupervisorSession: runRealSupervisorSession } = jest.requireActual<
  typeof import('../../../../../src/sandbox/local/core/hostRun')
>('../../../../../src/sandbox/local/core/hostRun');

describe('LocalSandboxProvider cancellation propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the caller signal through venv setup and the requested command', async () => {
    const sandboxRootPathParent = await mkdtemp(join(tmpdir(), 'tfy-local-cancel-'));
    const codeModeSocketParentPath = await mkdtemp(join(tmpdir(), 'tfy-local-cm-'));
    const sandboxId = join(sandboxRootPathParent, 'sandbox');
    await mkdir(join(sandboxId, '.venv', 'bin'), { recursive: true });
    await writeFile(join(sandboxId, '.venv', 'bin', 'python'), '');

    const session: hostRun.SessionResult = {
      stdoutText: '',
      stderrText: '',
      exitCode: 0,
      protocolError: undefined,
      timedOut: false,
      signal: undefined,
      childPid: undefined,
    };
    jest.mocked(hostRun.initSrt).mockResolvedValue(undefined);
    const resetSrt = jest.mocked(hostRun.resetSrt).mockResolvedValue(undefined);
    const runSupervisorSession = jest.mocked(hostRun.runSupervisorSession).mockResolvedValue(session);
    jest.mocked(codeMode.assertCodeModeSocketParentPath).mockReturnValue(codeModeSocketParentPath);
    const provider = new LocalSandboxProvider({
      sandboxRootPathParent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'linux', shell: '/bin/sh', python: '/usr/bin/python3' },
      logger: createLogger({ silent: true }),
    });
    const controller = new AbortController();

    try {
      await expect(
        provider.exec({ sandboxId, command: 'printf cancellation-check', signal: controller.signal }),
      ).resolves.toEqual({
        success: true,
        response: { exitCode: 0, result: '' },
      });

      expect(runSupervisorSession).toHaveBeenCalledTimes(2);
      expect(runSupervisorSession.mock.calls.every(([params]) => params.signal === controller.signal)).toBe(true);
    } finally {
      await provider.dispose();
      expect(resetSrt).toHaveBeenCalledTimes(1);
      await rm(sandboxRootPathParent, { recursive: true, force: true });
      await rm(codeModeSocketParentPath, { recursive: true, force: true });
    }
  });

  it('does not report success when the signal aborts during the requested command', async () => {
    const sandboxRootPathParent = await mkdtemp(join(tmpdir(), 'tfy-local-cancel-'));
    const codeModeSocketParentPath = await mkdtemp(join(tmpdir(), 'tfy-local-cm-'));
    const sandboxId = join(sandboxRootPathParent, 'sandbox');
    await mkdir(join(sandboxId, '.venv', 'bin'), { recursive: true });
    await writeFile(join(sandboxId, '.venv', 'bin', 'python'), '');

    const session: hostRun.SessionResult = {
      stdoutText: '',
      stderrText: '',
      exitCode: 0,
      protocolError: undefined,
      timedOut: false,
      signal: undefined,
      childPid: undefined,
    };
    jest.mocked(hostRun.initSrt).mockResolvedValue(undefined);
    const resetSrt = jest.mocked(hostRun.resetSrt).mockResolvedValue(undefined);
    const controller = new AbortController();
    let supervisorCalls = 0;
    const runSupervisorSession = jest.mocked(hostRun.runSupervisorSession).mockImplementation(async () => {
      supervisorCalls += 1;
      if (supervisorCalls === 2) {
        controller.abort(new Error('cancel running command'));
      }
      return session;
    });
    jest.mocked(codeMode.assertCodeModeSocketParentPath).mockReturnValue(codeModeSocketParentPath);
    const provider = new LocalSandboxProvider({
      sandboxRootPathParent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'linux', shell: '/bin/sh', python: '/usr/bin/python3' },
      logger: createLogger({ silent: true }),
    });

    try {
      await expect(
        provider.exec({ sandboxId, command: 'printf cancellation-check', signal: controller.signal }),
      ).resolves.toEqual({ success: false, error: 'cancel running command' });
      expect(runSupervisorSession).toHaveBeenCalledTimes(2);
    } finally {
      await provider.dispose();
      expect(resetSrt).toHaveBeenCalledTimes(1);
      await rm(sandboxRootPathParent, { recursive: true, force: true });
      await rm(codeModeSocketParentPath, { recursive: true, force: true });
    }
  });

  it('rolls back only a sandbox root created by the current setup attempt', async () => {
    const sandboxRootPathParent = await mkdtemp(join(tmpdir(), 'tfy-local-cancel-'));
    const codeModeSocketParentPath = await mkdtemp(join(tmpdir(), 'tfy-local-cm-'));
    jest.mocked(hostRun.initSrt).mockResolvedValue(undefined);
    const resetSrt = jest.mocked(hostRun.resetSrt).mockResolvedValue(undefined);
    jest.mocked(codeMode.assertCodeModeSocketParentPath).mockReturnValue(codeModeSocketParentPath);
    const removeSandbox = jest.mocked(hostRun.removeSandbox);
    jest.mocked(ulid).mockReturnValueOnce('OWNED-ROOT').mockReturnValueOnce('PREEXISTING-ROOT');
    const provider = new LocalSandboxProvider({
      sandboxRootPathParent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'linux', shell: '/bin/sh', python: 'missing-python-for-cancellation-test' },
      logger: createLogger({ silent: true }),
    });

    try {
      await expect(provider.createSandbox()).rejects.toThrow(/Failed to create sandbox \.venv/);
      await expect(readdir(sandboxRootPathParent)).resolves.toEqual([]);

      const preexistingRoot = join(sandboxRootPathParent, 'preexisting-root');
      const sentinelPath = join(preexistingRoot, 'sentinel.txt');
      await mkdir(preexistingRoot);
      await writeFile(sentinelPath, 'must survive');
      await expect(provider.createSandbox()).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('must survive');

      expect(removeSandbox).toHaveBeenCalledTimes(1);
      expect(removeSandbox).toHaveBeenCalledWith(join(sandboxRootPathParent, 'owned-root'));
    } finally {
      await provider.dispose();
      expect(resetSrt).toHaveBeenCalledTimes(1);
      await rm(sandboxRootPathParent, { recursive: true, force: true });
      await rm(codeModeSocketParentPath, { recursive: true, force: true });
    }
  });

  it('kills and cleans up the spawned process when onChildSpawn throws', async () => {
    const sandboxRootPath = await mkdtemp(join(tmpdir(), 'tfy-local-spawn-callback-'));
    await mkdir(join(sandboxRootPath, '.tmp'));
    await mkdir(join(sandboxRootPath, '.home'));
    const callbackError = new Error('spawn callback failed');
    const controller = new AbortController();
    const removeAbortListener = jest.spyOn(controller.signal, 'removeEventListener');
    const wrapWithSandboxArgv = jest.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockResolvedValue({
      argv: [process.execPath, '-e', 'setInterval(() => undefined, 1_000)'],
      env: {},
    });
    const cleanupAfterCommand = jest.spyOn(SandboxManager, 'cleanupAfterCommand').mockImplementation(() => undefined);
    let childPid: number | undefined;

    try {
      await expect(
        runRealSupervisorSession({
          sandboxRootPath,
          command: 'ignored by test wrapper',
          shell: process.execPath,
          platform: 'linux',
          signal: controller.signal,
          onChildSpawn: pid => {
            childPid = pid;
            expect(() => process.kill(pid, 0)).not.toThrow();
            throw callbackError;
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toBe(callbackError);

      expect(childPid).toBeDefined();
      expect(() => process.kill(childPid!, 0)).toThrow();
      expect(cleanupAfterCommand).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The expected cleanup path already terminated the child.
        }
      }
      wrapWithSandboxArgv.mockRestore();
      cleanupAfterCommand.mockRestore();
      removeAbortListener.mockRestore();
      await rm(sandboxRootPath, { recursive: true, force: true });
    }
  });
});
