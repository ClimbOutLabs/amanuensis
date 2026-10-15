import { createLogger, transports } from 'winston';

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  return {
    ...actual,
    __esModule: true,
    default: { ...actual.default, STT_URL: 'http://stt-test:8001' },
  };
});

const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
global.fetch = fetchMock;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type SttAvailabilityModule = typeof import('../../../src/voice/sttAvailability');

/** Fresh module per test: the cached flag and watcher state are module-level. */
async function loadModule(): Promise<SttAvailabilityModule> {
  jest.resetModules();
  return import('../../../src/voice/sttAvailability');
}

describe('sttAvailability', () => {
  const logger = createLogger({ transports: [new transports.Console({ silent: true })] });

  beforeEach(() => {
    fetchMock.mockReset();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('probeSttHealth', () => {
    it('resolves true when the sidecar answers 200 with a loaded model', async () => {
      const mod = await loadModule();
      fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', model_loaded: true }, 200));

      await expect(mod.probeSttHealth({ logger })).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('http://stt-test:8001/healthz', expect.anything());
    });

    it('resolves false when the model is not loaded yet', async () => {
      const mod = await loadModule();
      fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', model_loaded: false }, 200));

      await expect(mod.probeSttHealth({ logger })).resolves.toBe(false);
    });

    it('resolves false on a non-200 health response', async () => {
      const mod = await loadModule();
      fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));

      await expect(mod.probeSttHealth({ logger })).resolves.toBe(false);
    });

    it('resolves false when the sidecar is unreachable', async () => {
      const mod = await loadModule();
      fetchMock.mockRejectedValue(new Error('connection refused'));

      await expect(mod.probeSttHealth({ logger })).resolves.toBe(false);
    });
  });

  describe('startSttAvailabilityWatcher', () => {
    it('reads false until the first probe resolves, then tracks the 30s re-checks', async () => {
      jest.useFakeTimers();
      const mod = await loadModule();
      expect(mod.isVoiceAvailable()).toBe(false);

      fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', model_loaded: true }, 200));
      mod.startSttAvailabilityWatcher({ logger });
      await jest.advanceTimersByTimeAsync(0);
      expect(mod.isVoiceAvailable()).toBe(true);

      fetchMock.mockRejectedValue(new Error('connection refused'));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mod.isVoiceAvailable()).toBe(false);

      fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', model_loaded: true }, 200));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mod.isVoiceAvailable()).toBe(true);
    });
  });
});
