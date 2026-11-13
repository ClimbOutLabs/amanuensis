import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { makeSilentLogger } from '../../harnessMocks';

describe('SlotSandboxProvider network declaration', () => {
  const provider = new SlotSandboxProvider({
    socketPaths: ['/unused.sock'],
    defaultExecTimeoutSeconds: 30,
    treeDiskMb: 100,
    fileMaxBytesForDownload: 1024,
    logger: makeSilentLogger(),
    sleepMs: undefined,
    gitBridge: undefined,
  });

  it('declares no network', () => {
    expect(provider.network).toBe('none');
  });

  it('tells the model there is no general network and not to try another tool', () => {
    const instructions = provider.getAdditionalInstructions();
    expect(instructions).toContain('No general network from code or the shell, by design.');
    expect(instructions).toContain(
      'When downloads are not allowed, packages cannot be downloaded; say that plainly instead of retrying, and do not try another tool to get around it.',
    );
    expect(instructions).toContain('chats without a project');
  });

  it('tells the model to build Python projects in a workspace environment, and that run_code cannot see it', () => {
    const instructions = provider.getAdditionalInstructions();
    expect(instructions).toContain(
      '`python3 -m venv --system-site-packages .venv`, then install with `.venv/bin/python -m pip install <package>` and run tests with `.venv/bin/python -m pytest`',
    );
    expect(instructions).toContain('run_code runs only the code it is given, in an empty folder');
  });
});
