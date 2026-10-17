import { createLogger, transports } from 'winston';

type SlotBackend = typeof import('../../../src/sandbox/slotBackend');

async function loadDefaultBackend(): Promise<SlotBackend> {
  const saved = process.env['SANDBOX_BACKEND'];
  delete process.env['SANDBOX_BACKEND'];
  try {
    let loaded: SlotBackend | undefined;
    await jest.isolateModulesAsync(async () => {
      loaded = await import('../../../src/sandbox/slotBackend');
    });
    if (loaded === undefined) {
      throw new Error('slotBackend did not load');
    }
    return loaded;
  } finally {
    if (saved !== undefined) {
      process.env['SANDBOX_BACKEND'] = saved;
    }
  }
}

describe('the default sandbox backend with no slots set up', () => {
  it('is the slots, with no sockets to ask', async () => {
    const backend = await loadDefaultBackend();
    expect(backend.slotsBackendEnabled()).toBe(true);
    expect(backend.slotSocketPaths()).toEqual([]);
  });

  it('reports the sandbox as not ready, in plain words, instead of falling back to Docker', async () => {
    const backend = await loadDefaultBackend();
    const logger = createLogger({ transports: [new transports.Console({ silent: true })] });
    const build = await backend.slotSandboxBuildStatus({ logger });
    expect(build.status).toBe('failed');
    expect(build.reason).toContain('aman doctor sandbox --fix');
  });
});
