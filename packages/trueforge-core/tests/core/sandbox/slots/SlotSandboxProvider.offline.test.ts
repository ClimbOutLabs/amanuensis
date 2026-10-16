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

  it('tells the model there is no network and not to try another tool', () => {
    expect(provider.getAdditionalInstructions()).toContain(
      'No network from code or the shell, by design. If a task needs the internet, say it cannot be done here and do not try another tool.',
    );
  });
});
