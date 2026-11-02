import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createServerVoiceApi, createVoiceInputApi } from '../src/voiceInputApi';

const transcription = {
  text: 'hello world',
  language: 'en',
  duration_ms: 120,
  model: 'whisper-small-int8',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capabilitiesFetcher(flags: boolean[], capture: { urls: string[] }): typeof fetch {
  const fetcher: typeof fetch = async url => {
    capture.urls.push(String(url));
    const flag = flags.length > 0 ? flags.shift() : false;
    return jsonResponse({ data: { voice: { enabled: flag }, sandbox: { enabled: false } } }, 200);
  };
  return fetcher;
}

test('subscribeAvailability reports null then false while the flag reads false', async () => {
  const capture: { urls: string[] } = { urls: [] };
  const api = createVoiceInputApi(capabilitiesFetcher([false], capture), { pollAttempts: 1 });
  const seen: (boolean | null)[] = [];
  const unsubscribe = api.subscribeAvailability(value => seen.push(value));

  await sleep(20);

  assert.deepEqual(seen, [null, false]);
  assert.equal(capture.urls.length, 1);
  assert.ok(capture.urls[0]?.endsWith('/api/v1/capabilities'));
  unsubscribe();
});

test('subscribeAvailability polls until the flag reads true, then latches', async () => {
  const capture: { urls: string[] } = { urls: [] };
  const api = createVoiceInputApi(capabilitiesFetcher([false, false, true], capture), {
    pollIntervalMs: 10,
    pollAttempts: 10,
  });
  const seen: (boolean | null)[] = [];
  api.subscribeAvailability(value => seen.push(value));

  await sleep(150);

  assert.ok(seen.includes(true));
  assert.equal(seen[seen.length - 1], true);
  const fetchCount = capture.urls.length;
  assert.ok(fetchCount >= 3, `expected at least 3 polls, got ${fetchCount}`);

  // Latched: no further refetches, and the value never flips back.
  await sleep(100);
  assert.equal(capture.urls.length, fetchCount);
  assert.equal(seen[seen.length - 1], true);
});

test('subscribeAvailability stops polling after the attempt budget without the flag', async () => {
  const capture: { urls: string[] } = { urls: [] };
  const api = createVoiceInputApi(capabilitiesFetcher([], capture), { pollIntervalMs: 10, pollAttempts: 2 });
  const seen: (boolean | null)[] = [];
  api.subscribeAvailability(value => seen.push(value));

  await sleep(120);

  assert.equal(capture.urls.length, 2);
  assert.deepEqual(seen, [null, false, false]);
});

test('subscribeAvailability reads a missing or malformed flag as false', async () => {
  const bodies = [{ data: {} }, { data: { voice: 'yes' } }, { nope: true }];
  for (const body of bodies) {
    const fetcher: typeof fetch = async () => jsonResponse(body, 200);
    const api = createVoiceInputApi(fetcher, { pollAttempts: 1 });
    const seen: (boolean | null)[] = [];
    api.subscribeAvailability(value => seen.push(value));
    await sleep(20);
    assert.deepEqual(seen, [null, false]);
  }
});

test('subscribeAvailability degrades to false when the capabilities read fails', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('network down');
  };
  const api = createVoiceInputApi(failing, { pollAttempts: 1 });
  const seen: (boolean | null)[] = [];
  api.subscribeAvailability(value => seen.push(value));
  await sleep(20);
  assert.deepEqual(seen, [null, false]);

  const http500: typeof fetch = async () => jsonResponse({}, 500);
  const api2 = createVoiceInputApi(http500, { pollAttempts: 1 });
  const seen2: (boolean | null)[] = [];
  api2.subscribeAvailability(value => seen2.push(value));
  await sleep(20);
  assert.deepEqual(seen2, [null, false]);
});

function transcribeFetcher(response: Response, capture: { url?: string; init?: RequestInit }): typeof fetch {
  const fetcher: typeof fetch = async (url, init) => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
  return fetcher;
}

test('transcribe posts the WAV blob with no language hint and returns the transcript', async () => {
  const capture: { url?: string; init?: RequestInit } = {};
  const api = createVoiceInputApi(transcribeFetcher(jsonResponse({ data: transcription }, 200), capture));
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

  const result = await api.transcribe({ audio });

  assert.deepEqual(result, transcription);
  assert.ok(capture.url?.endsWith('/api/v1/voice/transcribe'));
  assert.ok(!capture.url?.includes('?'), 'v1 sends no query params');
  assert.equal(capture.init?.method, 'POST');
  assert.deepEqual((capture.init?.headers as Record<string, string>)['Content-Type'], 'audio/wav');
  assert.equal(capture.init?.body, audio);
});

test('transcribe also accepts the bare transcription object', async () => {
  const api = createVoiceInputApi(transcribeFetcher(jsonResponse(transcription, 200), {}));

  assert.deepEqual(await api.transcribe({ audio: new Blob(['x']) }), transcription);
});

test('transcribe throws the server error message on failure', async () => {
  const api = createVoiceInputApi(
    transcribeFetcher(
      jsonResponse({ error: { message: 'Audio could not be transcribed', code: 'bad_audio' } }, 400),
      {},
    ),
  );
  await assert.rejects(api.transcribe({ audio: new Blob(['x']) }), /Audio could not be transcribed/);

  // v2 503 shape: `{ "error": "voice input unavailable" }`.
  const unavailable = createVoiceInputApi(
    transcribeFetcher(jsonResponse({ error: 'voice input unavailable' }, 503), {}),
  );
  await assert.rejects(unavailable.transcribe({ audio: new Blob(['x']) }), /voice input unavailable/);
});

test('transcribe throws on a malformed response body', async () => {
  const api = createVoiceInputApi(transcribeFetcher(jsonResponse({ data: { text: 42 } }, 200), {}));

  await assert.rejects(api.transcribe({ audio: new Blob(['x']) }), /invalid/);
});

test('transcribe forwards the caller abort signal to the fetch', async () => {
  const capture: { init?: RequestInit } = {};
  // Like a real fetch, rejects at once when the signal is already aborted.
  const hanging: typeof fetch = (_url, init) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const wrapped: typeof fetch = async (url, init) => {
    capture.init = init;
    return hanging(url, init);
  };
  const api = createVoiceInputApi(wrapped, { transcribeTimeoutMs: 60_000 });

  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(api.transcribe({ audio: new Blob(['x']), signal: controller.signal }), /cancelled/);
  assert.equal(capture.init?.signal?.aborted, true);
});

test('transcribe aborts a hanging request at the client timeout', async () => {
  const hanging: typeof fetch = (_url, init) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const api = createVoiceInputApi(hanging, { transcribeTimeoutMs: 30 });

  await assert.rejects(api.transcribe({ audio: new Blob(['x']) }), /timed out/);
});

test('server voice posts the reply text and the chosen voice, and returns the audio', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/wav' } });
  };

  const audio = await createServerVoiceApi(fetcher).speak({ text: 'Hello there.', voice: 'am_michael' });

  assert.equal(audio.size, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? '', /\/api\/v1\/voice\/speak$/);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ text: 'Hello there.', voice: 'am_michael' }));
});

test('server voice rejects with the server message when the voice is off', async () => {
  const fetcher: typeof fetch = async () =>
    jsonResponse(
      { error: { message: 'The voice on this computer is not available right now.', code: 'tts_unavailable' } },
      503,
    );

  await assert.rejects(
    createServerVoiceApi(fetcher).speak({ text: 'Hi.', voice: 'af_heart' }),
    /not available right now/,
  );
});

test('server voice rejects an answer that is not audio', async () => {
  const fetcher: typeof fetch = async () => jsonResponse({}, 200);

  await assert.rejects(createServerVoiceApi(fetcher).speak({ text: 'Hi.', voice: 'af_heart' }), /not audio/);
});
