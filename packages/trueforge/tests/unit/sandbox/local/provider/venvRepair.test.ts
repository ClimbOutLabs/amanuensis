jest.mock('../../../../../src/sandbox/local/core/hostRun', () => {
  const actual = jest.requireActual<typeof import('../../../../../src/sandbox/local/core/hostRun')>(
    '../../../../../src/sandbox/local/core/hostRun',
  );
  return {
    ...actual,
    initSrt: jest.fn(),
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

import { withTrustedPath } from '@truefoundry/trueforge-core/core';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import * as codeMode from '../../../../../src/sandbox/local/core/CodeModeUdsTransport';
import * as hostRun from '../../../../../src/sandbox/local/core/hostRun';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

const PYTHON = '/usr/bin/python3';
const REBUILD_COMMAND = withTrustedPath(`rm -rf -- '.venv' && '${PYTHON}' -I -m venv '.venv'`);

function session(overrides: Partial<hostRun.SessionResult> = {}): hostRun.SessionResult {
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

/** Lays out the entries a usable venv has, as plain files the host never runs. */
async function writeVenvLayout(venvDir: string): Promise<void> {
  await mkdir(join(venvDir, 'bin'), { recursive: true });
  await writeFile(join(venvDir, 'pyvenv.cfg'), '');
  await writeFile(join(venvDir, 'bin', 'python'), '');
  await writeFile(join(venvDir, 'bin', 'pip'), '');
}

describe('LocalSandboxProvider venv repair', () => {
  let parent: string;
  let sandboxId: string;
  let provider: LocalSandboxProvider;

  beforeEach(async () => {
    jest.clearAllMocks();
    parent = await mkdtemp(join(tmpdir(), 'tfy-local-venv-repair-'));
    sandboxId = join(parent, 'sandbox');
    await mkdir(sandboxId);
    const codeModeSocketParentPath = join(parent, 'cm');
    jest.mocked(hostRun.initSrt).mockResolvedValue(undefined);
    jest.mocked(hostRun.resetSrt).mockResolvedValue(undefined);
    jest.mocked(hostRun.runSupervisorSession).mockResolvedValue(session());
    jest.mocked(codeMode.assertCodeModeSocketParentPath).mockReturnValue(codeModeSocketParentPath);
    provider = new LocalSandboxProvider({
      sandboxRootPathParent: parent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'linux', shell: '/bin/sh', python: PYTHON },
      logger: createLogger({ silent: true }),
    });
  });

  afterEach(async () => {
    await provider.dispose();
    await rm(parent, { recursive: true, force: true });
  });

  function sessionCommands(): string[] {
    return jest.mocked(hostRun.runSupervisorSession).mock.calls.map(([params]) => params.command);
  }

  it('leaves a complete venv alone', async () => {
    await writeVenvLayout(join(sandboxId, '.venv'));
    await provider.exec({ sandboxId, command: 'true' });
    expect(sessionCommands()).toHaveLength(1);
    expect(sessionCommands()[0]).not.toContain('venv');
  });

  it.each([join('bin', 'python'), join('bin', 'pip'), 'pyvenv.cfg'])(
    'rebuilds the venv inside the sandbox when `%s` is missing',
    async entry => {
      const venvDir = join(sandboxId, '.venv');
      await writeVenvLayout(venvDir);
      await rm(join(venvDir, entry));
      await provider.exec({ sandboxId, command: 'true' });
      expect(sessionCommands()).toEqual([REBUILD_COMMAND, expect.any(String)]);
    },
  );

  it('rebuilds a linked venv inside the sandbox and leaves the link target alone', async () => {
    const elsewhere = join(parent, 'elsewhere');
    await writeVenvLayout(elsewhere);
    await symlink(elsewhere, join(sandboxId, '.venv'));
    await provider.exec({ sandboxId, command: 'true' });
    expect(sessionCommands()).toEqual([REBUILD_COMMAND, expect.any(String)]);
    expect((await readdir(elsewhere)).sort()).toEqual(['bin', 'pyvenv.cfg']);
  });

  it('reports a failed rebuild without running the command', async () => {
    jest.mocked(hostRun.runSupervisorSession).mockResolvedValue(session({ exitCode: 1, stderrText: 'no venv module' }));
    await expect(provider.exec({ sandboxId, command: 'true' })).resolves.toEqual({
      success: false,
      error: 'Failed to create sandbox .venv: no venv module',
    });
    expect(sessionCommands()).toEqual([REBUILD_COMMAND]);
  });
});
