import { createLogger, transports } from 'winston';

import { createVoiceRouter } from '../../../src/apis/voice';
import { resolveRequestContext } from '../../../src/auth/identity';

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

const TRANSCRIPT = 'the quick brown fox jumps over the lazy dog';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wavRequest(
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', ...headers },
    body,
    // Required by undici when the body is a stream.
    duplex: 'half',
  } as RequestInit);
}

describe('voice HTTP endpoints', () => {
  const logger = createLogger({ transports: [new transports.Console({ silent: true })] });
  const infoSpy = jest.spyOn(logger, 'info');
  const warnSpy = jest.spyOn(logger, 'warn');
  const router = createVoiceRouter({ logger, resolveRequestContext });

  beforeEach(() => {
    fetchMock.mockReset();
    infoSpy.mockClear();
    warnSpy.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function loggedText(): string {
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls].map(call => JSON.stringify(call)).join(' ');
  }

  describe('GET /status', () => {
    it('reports available when the sidecar health probe shows a loaded model', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ model_loaded: true }, 200));

      const res = await router.request('/status');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { stt_available: true, model: 'whisper-small-int8' } });
      expect(fetchMock).toHaveBeenCalledWith('http://stt-test:8001/healthz', expect.anything());
    });

    it('reports unavailable when the sidecar model is not warm', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ model_loaded: false }, 200));

      const res = await router.request('/status');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { stt_available: false, model: '' } });
    });

    it('reports unavailable when the sidecar is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));

      const res = await router.request('/status');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { stt_available: false, model: '' } });
    });
  });

  describe('POST /transcribe', () => {
    const sidecarTranscript = {
      text: TRANSCRIPT,
      language: 'en',
      duration_ms: 12,
      model: 'whisper-small-int8',
    };

    it('forwards WAV bytes to the sidecar and returns the transcript', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sidecarTranscript, 200));
      const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

      const res = await router.request(wavRequest(audio));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: sidecarTranscript });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('http://stt-test:8001/v1/transcribe');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['content-type']).toBe('audio/wav');
      expect(init?.body).toBeInstanceOf(Uint8Array);
    });

    it('passes no language hint; the sidecar auto-detects', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sidecarTranscript, 200));

      const res = await router.request(
        new Request('http://localhost/transcribe?language=en', {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: new Uint8Array([1, 2, 3]),
        }),
      );

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://stt-test:8001/v1/transcribe');
    });

    it('rejects a non-WAV content type with 400', async () => {
      const res = await router.request(
        new Request('http://localhost/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an empty audio body with 400', async () => {
      const res = await router.request(wavRequest(new Uint8Array(0)));

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an oversized declared body with 413 before reading it', async () => {
      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      const res = await router.request(wavRequest(oversized, { 'content-length': String(30 * 1024 * 1024 + 1) }));

      expect(res.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 503 when the sidecar is unreachable, with no retry', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('stt_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the forward times out', async () => {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeoutError);

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries an immediate 503 up to 3 attempts, 2s apart, then fails', async () => {
      jest.useFakeTimers();
      fetchMock.mockResolvedValue(new Response('not ready', { status: 503 }));

      const pending = router.request(wavRequest(new Uint8Array([1, 2, 3])));
      await jest.advanceTimersByTimeAsync(5_000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('recovers when a retried 503 warms up', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response('not ready', { status: 503 }))
        .mockResolvedValueOnce(jsonResponse(sidecarTranscript, 200));

      const pending = router.request(wavRequest(new Uint8Array([1, 2, 3])));
      await jest.advanceTimersByTimeAsync(2_000);
      const res = await pending;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: sidecarTranscript });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('passes through a 400 sidecar rejection as 400', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'bad wav' }, 400));

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(400);
    });

    it('returns 502 when the sidecar fails unexpectedly', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(502);
    });

    it('returns 502 when the sidecar response is malformed', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: 42 }, 200));

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(502);
    });

    it('never logs the transcript', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sidecarTranscript, 200));

      const res = await router.request(wavRequest(new Uint8Array([1, 2, 3])));

      expect(res.status).toBe(200);
      expect(loggedText()).not.toContain(TRANSCRIPT);
    });
  });
});
