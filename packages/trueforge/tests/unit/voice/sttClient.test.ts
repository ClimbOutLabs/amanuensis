import { forwardToSidecar } from '../../../src/voice/sttClient';

describe('forwardToSidecar', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
