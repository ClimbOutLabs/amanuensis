import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVoiceInputApi } from '../src/voiceInputApi';

const transcription = {
  text: 'hello world',
  language: 'en',
  duration_ms: 120,
  model: 'whisper-small-int8',
};

function fetcherReturning(response: Response, capture: { url?: string; init?: RequestInit }): typeof fetch {
  const fetcher: typeof fetch = async (url, init) => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
  return fetcher;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('getStatus returns the parsed STT availability', async () => {
  const capture: { url?: string } = {};
  const api = createVoiceInputApi(
    fetcherReturning(jsonResponse({ data: { stt_available: true, model: 'whisper-small-int8' } }, 200), capture),
  );

  const status = await api.getStatus();

  assert.deepEqual(status, { stt_available: true, model: 'whisper-small-int8' });
  assert.ok(capture.url?.endsWith('/api/v1/voice/status'));
});

test('getStatus degrades to unavailable when the probe fails', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('network down');
  };
  assert.deepEqual(await createVoiceInputApi(failing).getStatus(), { stt_available: false, model: '' });

  const capture: { url?: string } = {};
  const http500 = createVoiceInputApi(fetcherReturning(jsonResponse({}, 500), capture));
  assert.deepEqual(await http500.getStatus(), { stt_available: false, model: '' });
});

test('transcribe posts the WAV blob and returns the transcript', async () => {
  const capture: { url?: string; init?: RequestInit } = {};
  const api = createVoiceInputApi(fetcherReturning(jsonResponse({ data: transcription }, 200), capture));
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

  const result = await api.transcribe({ audio });

  assert.deepEqual(result, transcription);
  assert.ok(capture.url?.endsWith('/api/v1/voice/transcribe'));
  assert.equal(capture.init?.method, 'POST');
  assert.deepEqual((capture.init?.headers as Record<string, string>)['Content-Type'], 'audio/wav');
  assert.equal(capture.init?.body, audio);
});

test('transcribe forwards the language hint as a query parameter', async () => {
  const capture: { url?: string } = {};
  const api = createVoiceInputApi(fetcherReturning(jsonResponse({ data: transcription }, 200), capture));

  await api.transcribe({ audio: new Blob(['x']), language: 'es' });

  assert.ok(capture.url?.endsWith('/api/v1/voice/transcribe?language=es'));
});

test('transcribe throws the server error message on failure', async () => {
  const api = createVoiceInputApi(
    fetcherReturning(
      jsonResponse({ error: { message: 'Audio could not be transcribed', code: 'bad_audio' } }, 400),
      {},
    ),
  );

  await assert.rejects(api.transcribe({ audio: new Blob(['x']) }), /Audio could not be transcribed/);
});

test('transcribe throws on a malformed response body', async () => {
  const api = createVoiceInputApi(fetcherReturning(jsonResponse({ data: { text: 42 } }, 200), {}));

  await assert.rejects(api.transcribe({ audio: new Blob(['x']) }), /invalid/);
});
