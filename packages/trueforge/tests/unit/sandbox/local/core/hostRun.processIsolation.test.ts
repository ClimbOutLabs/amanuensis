import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSrt, resetSrt, runSupervisorSession } from '../../../../../src/sandbox/local/core/hostRun';

/**
 * The sandbox wrapper gives each command its own process list unless it is told to run in its
 * weaker nested mode, where the command can see every process on the machine. These tests watch
 * every setting the host hands the wrapper, so that mode can never be switched on by a later change.
 */
describe('the sandbox never runs in the wrapper’s weaker nested mode', () => {
  let sandboxRootPath: string;
  let initializeSpy: jest.SpyInstance;
  let wrapSpy: jest.SpyInstance;
  let cleanupSpy: jest.SpyInstance;
  let resetSpy: jest.SpyInstance;

  beforeEach(async () => {
    sandboxRootPath = await mkdtemp(join(tmpdir(), 'tfy-process-isolation-'));
    await mkdir(join(sandboxRootPath, '.tmp'));
    await mkdir(join(sandboxRootPath, '.home'));
    initializeSpy = jest.spyOn(SandboxManager, 'initialize').mockResolvedValue(undefined);
    wrapSpy = jest.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockResolvedValue({
      argv: [process.execPath, '-e', ''],
      env: {},
    });
    cleanupSpy = jest.spyOn(SandboxManager, 'cleanupAfterCommand').mockImplementation(() => undefined);
    resetSpy = jest.spyOn(SandboxManager, 'reset').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await resetSrt();
    initializeSpy.mockRestore();
    wrapSpy.mockRestore();
    cleanupSpy.mockRestore();
    resetSpy.mockRestore();
    await rm(sandboxRootPath, { recursive: true, force: true });
  });

  /** Every key named anywhere inside a settings value the host passed to the wrapper. */
  function keysIn(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const entry of value) {
        keysIn(entry, into);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        into.add(key);
        keysIn(child, into);
      }
    }
    return into;
  }

  it.each(['linux', 'darwin'] as const)('starting the sandbox on %s never names the weaker mode', async platform => {
    await initSrt({ platform, hostBinaries: { bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg' } });
    expect(initializeSpy).toHaveBeenCalledTimes(1);
    const keys = keysIn(initializeSpy.mock.calls);
    expect(keys).toContain('filesystem');
    expect(keys).not.toContain('enableWeakerNestedSandbox');
  });

  it('running a command never names the weaker mode', async () => {
    await runSupervisorSession({
      sandboxRootPath,
      command: 'true',
      shell: '/bin/sh',
      platform: 'linux',
      signal: undefined,
      timeoutMs: 5_000,
    });
    expect(wrapSpy).toHaveBeenCalledTimes(1);
    const keys = keysIn(wrapSpy.mock.calls);
    expect(keys).toContain('filesystem');
    expect(keys).not.toContain('enableWeakerNestedSandbox');
  });
});
