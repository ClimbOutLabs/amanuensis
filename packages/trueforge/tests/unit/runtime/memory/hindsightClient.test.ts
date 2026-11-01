import { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const text = JSON.stringify(body);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(text, 'utf8')));
  }
  return new Response(text, { status: init?.status ?? 200, headers });
}

describe('HindsightClient', () => {
  describe('recall', () => {
    it('maps a successful response into results and entities', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          results: [{ id: '1', text: 'Alex likes tea', occurred_start: '2026-08-14T00:00:00Z' }],
          entities: {
            Robin: { canonical_name: 'Robin', observations: [{ text: 'is Alex’s wife', mentioned_at: '2026-08-01' }] },
          },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'who is Robin',
        maxTokens: 2048,
        entityTokens: 512,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: true,
        results: [{ id: '1', text: 'Alex likes tea', occurred_start: '2026-08-14T00:00:00Z' }],
        entities: [
          {
            name: 'Robin',
            canonical_name: 'Robin',
            observations: [{ text: 'is Alex’s wife', mentioned_at: '2026-08-01' }],
          },
        ],
      });
      const [url, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://hindsight.example/v1/default/banks/aman/memories/recall');
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        query: 'who is Robin',
        max_tokens: 2048,
        query_timestamp: '2026-08-30T00:00:00Z',
        types: ['world', 'experience', 'observation'],
        prefer_observations: true,
        include: { entities: { max_tokens: 512 } },
      });
    });

    it('leaves out items retained from the current chat and keeps other chats', async () => {
      const fetchImpl = jest.fn().mockImplementation(async () =>
        jsonResponse({
          results: [
            { id: '1', text: 'Discussed a follow-up', metadata: { session_id: 'chat-now' } },
            {
              id: '2',
              text: 'Landlord was told about the heater',

              metadata: { session_id: 'chat-old' },
            },
            { id: '3', text: 'Older note with no chat recorded' },
          ],
          entities: {},
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });
      const params = {
        query: 'follow-up',
        maxTokens: 2048,
        entityTokens: 0,
        queryTimestamp: '2026-10-26T00:00:00Z',
        timeoutMs: 2500,
      };

      const during = await client.recall({ ...params, currentSessionId: 'chat-now' });
      expect(during.ok && during.results.map(item => item.id)).toEqual(['2', '3']);
      const elsewhere = await client.recall({ ...params, currentSessionId: 'chat-3' });
      expect(elsewhere.ok && elsewhere.results.map(item => item.id)).toEqual(['1', '2', '3']);
    });

    it('returns ok:false on timeout', async () => {
      const fetchImpl = jest.fn().mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      });
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 50,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
    });

    it('returns ok:false when the response exceeds the configured byte cap', async () => {
      const oversizedBody = JSON.stringify({
        results: Array.from({ length: 50 }, () => ({ id: 'x', text: 'x'.repeat(50) })),
      });
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(oversizedBody, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(oversizedBody, 'utf8')) },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
        maxResponseBytes: 100,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds the 100 byte limit') });
    });

    it('resolves function-form headers and sends them on the request', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ results: [] }));
      const headers = jest.fn().mockResolvedValue({ headers: { Authorization: 'Bearer abc' } });
      const client = new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers, fetchImpl });

      await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(headers).toHaveBeenCalledTimes(1);
      const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect((requestInit.headers as Record<string, string>)['Authorization']).toBe('Bearer abc');
    });

    it('returns ok:false when the header resolver reports authRequired', async () => {
      const fetchImpl = jest.fn();
      const headers = jest.fn().mockResolvedValue({ authRequired: { servers: [] } });
      const client = new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers, fetchImpl });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('authorization') });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns ok:false when the header resolver rejects, without ever calling fetch', async () => {
      const fetchImpl = jest.fn();
      const headers = jest.fn().mockRejectedValue(new Error('kaboom'));
      const client = new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers, fetchImpl });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toMatchObject({
        ok: false,
        reason: expect.stringContaining('header resolution failed: kaboom'),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns ok:false within the timeout when the header resolver never resolves', async () => {
      const fetchImpl = jest.fn();
      const headers = jest.fn().mockReturnValue(new Promise<never>(() => undefined));
      const client = new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers, fetchImpl });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 25,
      });

      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns ok:false on a non-2xx response, carrying the status and the raw body as the detail', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(new Response('nope', { status: 401 }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: false,
        code: 'http_error',
        httpStatus: 401,
        detail: 'nope',
        reason: 'recall returned HTTP 401: nope',
      });
    });

    it("carries the provider's own `detail` message on a rejected credential", async () => {
      const body = JSON.stringify({ detail: 'Authentication failed: Invalid API key' });
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(body, {
          status: 401,
          headers: { 'content-length': String(Buffer.byteLength(body, 'utf8')) },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: false,
        code: 'http_error',
        httpStatus: 401,
        detail: 'Authentication failed: Invalid API key',
        reason: 'recall returned HTTP 401: Authentication failed: Invalid API key',
      });
    });

    it('cancels the stream reader when a chunked response with no content-length exceeds the cap', async () => {
      const encoder = new TextEncoder();
      // Far more chunks than needed to cross the cap: the source must still have unconsumed
      // chunks left when the cap trips, so a real cancel (not just a naturally-drained stream)
      // is the only way the reader can stop short of the end.
      const remainingChunks = Array.from({ length: 10 }, () => encoder.encode('x'.repeat(80)));
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = remainingChunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(stream, { status: 200 });
      expect(response.headers.has('content-length')).toBe(false);
      const fetchImpl = jest.fn().mockResolvedValue(response);
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
        maxResponseBytes: 100,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds the 100 byte limit') });
      expect(cancelled).toBe(true);
      // Proof the reader stopped early rather than the source running dry on its own.
      expect(remainingChunks.length).toBeGreaterThan(0);
    });

    it('reports a provider that stalls after sending headers as a timeout, not a malformed answer', async () => {
      const encoder = new TextEncoder();
      const fetchImpl = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal;
        // Headers and a first chunk arrive, then nothing until the send timeout fires.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"results":'));
            signal?.addEventListener(
              'abort',
              () => {
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      });
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 25,
      });

      expect(outcome).toEqual({ ok: false, code: 'timeout', reason: 'request timed out after 25ms' });
    });

    it('still reports an unparseable payload as invalid_response', async () => {
      const malformed = '{"results": [';
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(malformed, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(malformed, 'utf8')) },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({ ok: false, code: 'invalid_response', reason: 'recall response could not be parsed' });
    });

    it('still reports a stream that breaks for its own reason as invalid_response', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('socket hang up'));
        },
      });
      const fetchImpl = jest.fn().mockResolvedValue(new Response(stream, { status: 200 }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: false,
        code: 'invalid_response',
        reason: 'response could not be read: socket hang up',
      });
    });

    it('drops malformed result entries and entity observations, sanitizing the ones that survive', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          results: [null, 42, { id: 'x' }, { id: 'y', text: 'valid text', occurred_start: 12345 }],
          entities: {
            Robin: {
              canonical_name: 'Robin',
              observations: [null, 7, { mentioned_at: '2026-08-01' }, { text: 'is Alex’s wife', mentioned_at: 42 }],
            },
          },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: true,
        results: [{ id: 'y', text: 'valid text' }],
        entities: [{ name: 'Robin', canonical_name: 'Robin', observations: [{ text: 'is Alex’s wife' }] }],
      });
    });

    it('keeps a finite numeric score per item and per entity, dropping a non-numeric one', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          results: [
            { id: '1', text: 'scored high', score: 0.92 },
            { id: '2', text: 'scored low', score: 0.1 },
            { id: '3', text: 'not a number', score: 'high' },
            { id: '4', text: 'not finite', score: Number.NaN },
          ],
          entities: {
            Acme: { canonical_name: 'Acme', observations: [{ text: 'is a company' }], score: 0.7 },
            Widgets: { canonical_name: 'Widgets', observations: [{ text: 'is a product' }], score: 'unscored' },
          },
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 2500,
      });

      expect(outcome).toEqual({
        ok: true,
        results: [
          { id: '1', text: 'scored high', score: 0.92 },
          { id: '2', text: 'scored low', score: 0.1 },
          { id: '3', text: 'not a number' },
          { id: '4', text: 'not finite' },
        ],
        entities: [
          { name: 'Acme', canonical_name: 'Acme', observations: [{ text: 'is a company' }], score: 0.7 },
          { name: 'Widgets', canonical_name: 'Widgets', observations: [{ text: 'is a product' }] },
        ],
      });
    });

    it('retries a 503 once the lane frees up and succeeds', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ detail: 'lane saturated' }, { status: 503, headers: { 'retry-after': '0' } }),
        )
        .mockResolvedValueOnce(jsonResponse({ results: [], entities: {} }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 5000,
      });

      expect(outcome).toEqual({ ok: true, results: [], entities: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('gives up after three retries and reports the provider refusal', async () => {
      // A fresh Response per attempt, like a real server would send: reusing one Response
      // would hand every attempt the same already-consumed body stream.
      const fetchImpl = jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(jsonResponse({ detail: 'lane saturated' }, { status: 503, headers: { 'retry-after': '0' } })),
        );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.recall({
        query: 'q',
        maxTokens: 100,
        entityTokens: 10,
        queryTimestamp: '2026-08-30T00:00:00Z',
        timeoutMs: 5000,
      });

      expect(outcome).toMatchObject({ ok: false, code: 'http_error', httpStatus: 503 });
      expect(outcome).toMatchObject({ reason: expect.stringContaining('recall returned HTTP 503') });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('honors the Retry-After delay before retrying', async () => {
      jest.useFakeTimers();
      try {
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(jsonResponse({ detail: 'busy' }, { status: 503, headers: { 'retry-after': '2' } }))
          .mockResolvedValueOnce(jsonResponse({ results: [], entities: {} }));
        const client = new HindsightClient({
          apiBase: 'https://hindsight.example',
          bank: 'aman',
          headers: {},
          fetchImpl,
        });

        const outcomePromise = client.recall({
          query: 'q',
          maxTokens: 100,
          entityTokens: 10,
          queryTimestamp: '2026-08-30T00:00:00Z',
          timeoutMs: 30_000,
        });
        await jest.advanceTimersByTimeAsync(2500);
        const outcome = await outcomePromise;

        expect(outcome).toEqual({ ok: true, results: [], entities: [] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('waits the default interval when Retry-After is missing or malformed', async () => {
      jest.useFakeTimers();
      try {
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(jsonResponse({ detail: 'busy' }, { status: 503, headers: { 'retry-after': 'soon' } }))
          .mockResolvedValueOnce(jsonResponse({ results: [], entities: {} }));
        const client = new HindsightClient({
          apiBase: 'https://hindsight.example',
          bank: 'aman',
          headers: {},
          fetchImpl,
        });

        const outcomePromise = client.recall({
          query: 'q',
          maxTokens: 100,
          entityTokens: 10,
          queryTimestamp: '2026-08-30T00:00:00Z',
          timeoutMs: 30_000,
        });
        await jest.advanceTimersByTimeAsync(1200);
        const outcome = await outcomePromise;

        expect(outcome.ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports the 503 without waiting when Retry-After outlasts the caller timeout', async () => {
      jest.useFakeTimers();
      try {
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(jsonResponse({ detail: 'busy' }, { status: 503, headers: { 'retry-after': '30' } }));
        const client = new HindsightClient({
          apiBase: 'https://hindsight.example',
          bank: 'aman',
          headers: {},
          fetchImpl,
        });

        // No timers are advanced, so this resolves only if the client does not sleep.
        const outcome = await client.recall({
          query: 'q',
          maxTokens: 100,
          entityTokens: 10,
          queryTimestamp: '2026-08-30T00:00:00Z',
          timeoutMs: 100,
        });

        expect(outcome).toMatchObject({ ok: false, code: 'http_error', httpStatus: 503 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('retain', () => {
    it('treats 200 as ok', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.retain({
        items: [{ content: 'hi', timestamp: '2026-08-30T00:00:00Z', document_id: 'doc-1' }],
        operationId: 'op-1',
        timeoutMs: 10_000,
      });

      expect(outcome).toEqual({ ok: true });
    });

    it('treats 409 (already submitted) as ok', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: 'conflict' }, { status: 409 }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.retain({
        items: [{ content: 'hi', timestamp: '2026-08-30T00:00:00Z', document_id: 'doc-1' }],
        operationId: 'op-1',
        timeoutMs: 10_000,
      });

      expect(outcome).toEqual({ ok: true });
    });

    it('does not retry a 503: the sweep is retain’s retry loop, and a retried submit could double-write', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(jsonResponse({ detail: 'busy' }, { status: 503, headers: { 'retry-after': '0' } }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.retain({
        items: [{ content: 'hi', timestamp: '2026-08-30T00:00:00Z', document_id: 'doc-1' }],
        operationId: 'op-1',
        timeoutMs: 10_000,
      });

      expect(outcome).toEqual({ ok: false, reason: 'retain returned HTTP 503: busy' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOperation', () => {
    it('maps the status field', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ status: 'completed' }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.getOperation('op-1', 5000);
      expect(outcome).toEqual({ ok: true, status: 'completed' });
    });

    it('treats 404 as unknown', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, { status: 404 }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.getOperation('op-1', 5000);
      expect(outcome).toEqual({ ok: true, status: 'unknown' });
    });
  });

  describe('retryOperation', () => {
    it('reports ok based on the HTTP response status', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.retryOperation('op-1', 5000);
      expect(outcome).toEqual({ ok: true });
    });

    it('reports not ok when the header resolver fails', async () => {
      const fetchImpl = jest.fn();
      const headers = jest.fn().mockResolvedValue({ authRequired: { servers: [] } });
      const client = new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers, fetchImpl });

      const outcome = await client.retryOperation('op-1', 5000);
      expect(outcome).toEqual({ ok: false });
    });
  });

  describe('getProfile', () => {
    function makeProfileClient(fetchImpl: jest.Mock) {
      return new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });
    }

    it('reads mission and background from the 0.10.0 bank config API without touching the legacy path', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          bank_id: 'aman',
          config: { reflect_mission: 'Help Sid', retain_extraction_mode: 'verbose' },
          overrides: {},
        }),
      );

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toEqual({
        ok: true,
        profile: { name: undefined, mission: 'Help Sid', background: 'Help Sid' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://hindsight.example/v1/default/banks/aman/config');
    });

    it('maps a config without reflect_mission to an empty profile', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ bank_id: 'aman', config: {}, overrides: {} }));

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toEqual({
        ok: true,
        profile: { name: undefined, mission: undefined, background: undefined },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports invalid_response when the config body is malformed', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('not json', { status: 200, headers: { 'content-length': '8' } }));

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toEqual({
        ok: false,
        code: 'invalid_response',
        reason: 'profile response could not be parsed',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('falls back to the legacy profile endpoint when the config API 404s (pre-0.10.0 server)', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ detail: 'Bank configuration API is disabled' }, { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse({ bank_id: 'aman', name: 'Aman', mission: 'Help Sid', background: 'Rides bikes' }),
        );

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toEqual({
        ok: true,
        profile: { name: 'Aman', mission: 'Help Sid', background: 'Rides bikes' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://hindsight.example/v1/default/banks/aman/config');
      expect(String(fetchImpl.mock.calls[1]?.[0])).toBe('https://hindsight.example/v1/default/banks/aman/profile');
    });

    it('reports the config 404 when the legacy endpoint is also gone (410)', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ detail: "Bank 'nope' not found" }, { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse({ detail: 'The bank profile endpoints have been removed' }, { status: 410 }),
        );

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toMatchObject({ ok: false, code: 'http_error', httpStatus: 404 });
      expect(outcome).toMatchObject({ reason: expect.stringContaining('profile returned HTTP 404') });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('reports the legacy failure when the legacy endpoint fails for another reason', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ detail: 'disabled' }, { status: 404 }))
        .mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, { status: 500 }));

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toMatchObject({ ok: false, code: 'http_error', httpStatus: 500 });
    });

    it('does not fall back when the config read fails with a non-404', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ detail: 'boom' }, { status: 500 }));

      const outcome = await makeProfileClient(fetchImpl).getProfile(5000);

      expect(outcome).toMatchObject({ ok: false, code: 'http_error', httpStatus: 500 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does not fall back when the config read times out', async () => {
      const fetchImpl = jest.fn().mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      });

      const outcome = await makeProfileClient(fetchImpl).getProfile(100);

      expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMentalModels', () => {
    it('maps items, drops malformed entries, and passes the limit', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          items: [
            { id: 'm1', name: 'Taxes', content: 'Paid 12k in 2025', tags: ['tax', 7], is_stale: false },
            { id: 'm2', name: 'No content' },
            { id: 'm3', name: 'Old', content: 'stale note', is_stale: true },
            { id: 'm4', name: 'Unflagged', content: 'no verdict', is_stale: null },
          ],
          total: 4,
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.listMentalModels({ limit: 50, timeoutMs: 5000 });
      expect(outcome).toEqual({
        ok: true,
        models: [
          { id: 'm1', name: 'Taxes', content: 'Paid 12k in 2025', tags: ['tax'], isStale: false },
          { id: 'm3', name: 'Old', content: 'stale note', tags: [], isStale: true },
          { id: 'm4', name: 'Unflagged', content: 'no verdict', tags: [], isStale: undefined },
        ],
      });
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        'https://hindsight.example/v1/default/banks/aman/mental-models?limit=50',
      );
    });

    it('returns invalid_response for an unparseable body', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('not json', { status: 200, headers: { 'content-length': '8' } }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.listMentalModels({ limit: 50, timeoutMs: 5000 });
      expect(outcome).toEqual({
        ok: false,
        code: 'invalid_response',
        reason: 'mental models response could not be parsed',
      });
    });
  });

  describe('reflect', () => {
    it('posts the query with budget and token cap, and maps text and based_on', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        jsonResponse({
          text: 'You paid 12k.',
          based_on: { memories: [{ id: 'a' }, { id: 'b' }], mental_models: [{ id: 'm' }], directives: [] },
          usage: {},
        }),
      );
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.reflect({
        query: 'summarize my taxes',
        budget: 'low',
        maxTokens: 512,
        timeoutMs: 8000,
      });
      expect(outcome).toEqual({ ok: true, text: 'You paid 12k.', basedOn: 2 });
      const [url, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
      expect(String(url)).toBe('https://hindsight.example/v1/default/banks/aman/reflect');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        query: 'summarize my taxes',
        budget: 'low',
        max_tokens: 512,
        include: { facts: {} },
      });
    });

    it('counts zero sources when based_on is absent or null', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ text: 'Nothing on file.', based_on: null }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.reflect({ query: 'q', budget: 'low', maxTokens: 512, timeoutMs: 8000 });
      expect(outcome).toEqual({ ok: true, text: 'Nothing on file.', basedOn: 0 });
    });

    it('reports a non-2xx as a failure without throwing', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ detail: 'boom' }, { status: 500 }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.reflect({ query: 'q', budget: 'low', maxTokens: 512, timeoutMs: 8000 });
      expect(outcome.ok).toBe(false);
    });

    it('retries a 503 honoring Retry-After and succeeds', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ detail: 'busy' }, { status: 503, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(jsonResponse({ text: 'done', based_on: null }));
      const client = new HindsightClient({
        apiBase: 'https://hindsight.example',
        bank: 'aman',
        headers: {},
        fetchImpl,
      });

      const outcome = await client.reflect({ query: 'q', budget: 'low', maxTokens: 512, timeoutMs: 8000 });

      expect(outcome).toEqual({ ok: true, text: 'done', basedOn: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteDocument', () => {
    function clientWith(fetchImpl: jest.Mock): HindsightClient {
      return new HindsightClient({ apiBase: 'https://hindsight.example', bank: 'aman', headers: {}, fetchImpl });
    }

    it('sends a DELETE for the encoded document id', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));

      const outcome = await clientWith(fetchImpl).deleteDocument({
        documentId: 'aman-learned/profile',
        timeoutMs: 1000,
      });

      expect(outcome).toEqual({ ok: true });
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://hindsight.example/v1/default/banks/aman/documents/aman-learned%2Fprofile');
      expect(init.method).toBe('DELETE');
    });

    it('reads a 404 as done and says the document was already gone', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ detail: 'missing' }, { status: 404 }));

      const outcome = await clientWith(fetchImpl).deleteDocument({ documentId: 'gone', timeoutMs: 1000 });

      expect(outcome).toEqual({ ok: true, reason: 'document not found' });
    });

    it('reports a server error as a failure', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ detail: 'broken' }, { status: 500 }));

      const outcome = await clientWith(fetchImpl).deleteDocument({ documentId: 'doc', timeoutMs: 1000 });

      expect(outcome.ok).toBe(false);
    });
  });
});
