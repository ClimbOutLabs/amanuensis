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

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import * as codeMode from '../../../../../src/sandbox/local/core/CodeModeUdsTransport';
import * as hostRun from '../../../../../src/sandbox/local/core/hostRun';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('LocalSandboxProvider.createSandbox per-chat folder', () => {
  let scratch: string;
  let codeModeSocketParentPath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    scratch = await mkdtemp(join(tmpdir(), 'tfy-local-chat-folder-'));
    codeModeSocketParentPath = await mkdtemp(join(tmpdir(), 'tfy-local-cm-'));
    jest.mocked(hostRun.initSrt).mockResolvedValue(undefined);
    jest.mocked(hostRun.resetSrt).mockResolvedValue(undefined);
    jest.mocked(codeMode.assertCodeModeSocketParentPath).mockReturnValue(codeModeSocketParentPath);
    jest.mocked(hostRun.runSupervisorSession).mockResolvedValue({
      stdoutText: '',
      stderrText: '',
      exitCode: 0,
      protocolError: undefined,
      timedOut: false,
      signal: undefined,
      childPid: undefined,
    });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(codeModeSocketParentPath, { recursive: true, force: true });
  });

  function makeProvider(sandboxRootPathParent: string): LocalSandboxProvider {
    return new LocalSandboxProvider({
      sandboxRootPathParent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'linux', shell: '/bin/sh', python: '/usr/bin/python3' },
      logger: createLogger({ silent: true }),
    });
  }

  it('creates the private per-chat folder when a new chat starts its first sandbox', async () => {
    const chatFolder = join(scratch, 'sess_new_chat');
    const provider = makeProvider(chatFolder);

    const { sandboxId } = await provider.createSandbox();

    expect((await stat(chatFolder)).mode & 0o777).toBe(0o700);
    expect((await stat(sandboxId)).isDirectory()).toBe(true);
    await provider.dispose();
  });

  it('reports the failure instead of starting when the per-chat folder cannot be made', async () => {
    const blocker = join(scratch, 'not-a-folder');
    await writeFile(blocker, 'x');
    const provider = makeProvider(join(blocker, 'sess_new_chat'));

    await expect(provider.createSandbox()).rejects.toMatchObject({ code: 'ENOTDIR' });
    await provider.dispose();
  });
});
