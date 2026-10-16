import { APP_DISPLAY_VERSION } from '@truefoundry/trueforge-core/core/displayVersion';

import { printStandaloneStartupBanner } from '../../src/startupBanner';

describe('printStandaloneStartupBanner', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function printedBanner(): string {
    return logSpy.mock.calls.map(call => String(call[0])).join('\n');
  }

  it('prints the Aman banner with the display version and a shortened build stamp', () => {
    printStandaloneStartupBanner({ buildRef: '4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90', color: false });

    const banner = printedBanner();
    expect(banner).toContain(`Aman v${APP_DISPLAY_VERSION} · 4f2a91c`);
    expect(banner).toContain('standalone');
    expect(banner).not.toContain('TrueForge');
    expect(banner).not.toContain('TRUEFORGE');
  });

  it('reads as a dev build when there is no build stamp', () => {
    printStandaloneStartupBanner({ buildRef: undefined, color: false });

    expect(printedBanner()).toContain(`Aman v${APP_DISPLAY_VERSION} · dev`);
  });
});
