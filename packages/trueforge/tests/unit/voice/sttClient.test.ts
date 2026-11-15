import configuration from '../../../src/config';
import { forwardToSidecar } from '../../../src/voice/sttClient';

describe('forwardToSidecar', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('presents the shared speech secret', async () => {
    const original = configuration.SPEECH_SECRET;
    configuration.SPEECH_SECRET = 'synthetic-speech-secret-with-32-plus-chars';
    try {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      await forwardToSidecar(Uint8Array.of(1));
      expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
        'x-speech-secret': 'synthetic-speech-secret-with-32-plus-chars',
      });
    } finally {
      configuration.SPEECH_SECRET = original;
    }
  });

  it('stops waiting to retry as soon as the caller gives up', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
    const abort = new AbortController();
    const waiting = forwardToSidecar(Uint8Array.of(1), abort.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not wait out the retry delay when the caller gave up while the request was in flight', async () => {
    const abort = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      abort.abort();
      return Promise.resolve(new Response('', { status: 503 }));
    });
    const started = Date.now();
    await expect(forwardToSidecar(Uint8Array.of(1), abort.signal)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
