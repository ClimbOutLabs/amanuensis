/**
 * @jest-environment <rootDir>/tests/fixtures/voice/nativeArrays.environment.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import configuration from '../../../../src/config';
import {
  downloadVadModel,
  SILERO_VAD_MODEL,
  SileroSpeechProbability,
  VadModelUnavailableError,
  verifiedVadModel,
  type PinnedModel,
} from '../../../../src/voice/vad/sileroVad';
import { UtteranceDetector, VAD_WINDOW_SAMPLES } from '../../../../src/voice/vad/utteranceDetector';

const WINDOW_MS = 32;

describe('downloadVadModel', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vad-pin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function pinFor(bytes: Uint8Array): PinnedModel {
    return {
      fileName: 'model.onnx',
      url: 'https://example.invalid/model.onnx',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const answer =
    (bytes: Uint8Array): typeof fetch =>
    () =>
      Promise.resolve(new Response(bytes));

  it('saves the pinned file and reuses it without asking again', async () => {
    const bytes = new TextEncoder().encode('model bytes');
    const pin = pinFor(bytes);
    const target = await downloadVadModel({ dir, pin, fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    const never: typeof fetch = () => Promise.reject(new Error('should not download again'));
    await expect(downloadVadModel({ dir, pin, fetchFile: never })).resolves.toBe(target);
  });

  it('refuses a download that is not the pinned file, and saves nothing', async () => {
    const pin = pinFor(new TextEncoder().encode('model bytes'));
    const other = new TextEncoder().encode('model bytez');
    await expect(downloadVadModel({ dir, pin, fetchFile: answer(other) })).rejects.toBeInstanceOf(
      VadModelUnavailableError,
    );
    await expect(readFile(path.join(dir, 'model.onnx'))).rejects.toThrow();
  });

  it('replaces a saved file that no longer matches the pin', async () => {
    const bytes = new TextEncoder().encode('model bytes');
    await writeFile(path.join(dir, 'model.onnx'), 'tampered');
    const target = await downloadVadModel({ dir, pin: pinFor(bytes), fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  it('says what to do when the download fails', async () => {
    const pin = pinFor(new TextEncoder().encode('x'));
    const down: typeof fetch = () => Promise.reject(new Error('offline'));
    await expect(downloadVadModel({ dir, pin, fetchFile: down })).rejects.toThrow(/internet connection/);
  });
});

describe('verifiedVadModel', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vad-verify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = new TextEncoder().encode('model bytes');
  const pin: PinnedModel = {
    fileName: 'model.onnx',
    url: 'https://example.invalid/model.onnx',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  it('returns the bytes of a file that matches the pin', async () => {
    await writeFile(path.join(dir, 'model.onnx'), bytes);
    const loaded = await verifiedVadModel({ dir, pin });
    expect(Array.from(loaded)).toEqual(Array.from(bytes));
  });

  it('never downloads: a missing file says what to do for an image and for a checkout', async () => {
    await expect(verifiedVadModel({ dir, pin })).rejects.toThrow(/pnpm voice:model.*update Aman/);
  });

  it('refuses a file that is not the pinned one', async () => {
    await writeFile(path.join(dir, 'model.onnx'), 'model bytez');
    await expect(verifiedVadModel({ dir, pin })).rejects.toBeInstanceOf(VadModelUnavailableError);
  });
});

describe('the image build', () => {
  it.each(['Dockerfile', 'Dockerfile.dev'])('%s bakes in the same listening model the server pins', async name => {
    const text = await readFile(path.join(__dirname, '../../../../../..', name), 'utf8');
    expect(text).toContain(`--checksum=sha256:${SILERO_VAD_MODEL.sha256} ${SILERO_VAD_MODEL.url}`);
    expect(text).toMatch(/VOICE_VAD_MODEL_DIR=\/opt\/aman-voice/);
  });
});

/**
 * Two sentences of synthetic speech (the local Kokoro voice reading made-up lines), 16 kHz mono 16-bit, with
 * 0.4 s of quiet before and 0.9 s between and after. No real person's voice is in any test.
 */
const TWO_SENTENCES = new Int16Array(
  (() => {
    const bytes = readFileSync(path.join(__dirname, '../../../fixtures/voice/twoSentences16k.pcm'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  })(),
);

describe('Silero VAD on a fixture recording', () => {
  it('finds each utterance in a recording with two sentences and pauses between', async () => {
    // The pinned model is put in place by `pnpm voice:model` (CI caches it); no test downloads it.
    const model = await SileroSpeechProbability.load({
      model: await verifiedVadModel({ dir: configuration.VOICE_VAD_MODEL_DIR }),
    });
    const detector = new UtteranceDetector();
    const found: { startMs: number; endMs: number }[] = [];
    let index = 0;
    for (let offset = 0; offset + VAD_WINDOW_SAMPLES <= TWO_SENTENCES.length; offset += VAD_WINDOW_SAMPLES) {
      const window = TWO_SENTENCES.slice(offset, offset + VAD_WINDOW_SAMPLES);
      index += 1;
      const probability = await model.probability(window);
      for (const event of detector.push({ probability, window, endedAtMs: index * WINDOW_MS })) {
        if (event.type === 'utterance') {
          found.push({ startMs: event.startedAtMs, endMs: event.speechEndedAtMs });
        }
      }
    }
    await model.dispose();
    expect(found).toHaveLength(2);
    const [first, second] = found;
    // The speech is at 0.4 to 3.4 s and 4.3 to 7.0 s, give or take a syllable.
    expect(first?.startMs).toBeGreaterThan(200);
    expect(first?.startMs).toBeLessThan(800);
    expect(first?.endMs).toBeGreaterThan(2900);
    expect(first?.endMs).toBeLessThan(3800);
    expect(second?.startMs).toBeGreaterThan(3900);
    expect(second?.startMs).toBeLessThan(4700);
    expect(second?.endMs).toBeGreaterThan(6500);
    expect(second?.endMs).toBeLessThan(7500);
  }, 120_000);
});
