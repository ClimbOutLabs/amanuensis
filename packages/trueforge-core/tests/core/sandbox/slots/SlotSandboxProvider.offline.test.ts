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
      'When downloads are not allowed for the repo, packages cannot be downloaded; say that plainly instead of retrying, and do not try another tool to get around it.',
    );
  });
});
