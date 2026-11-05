/**
 * @jest-environment <rootDir>/tests/unit/voice/nativeArrays.environment.mjs
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureVadModel,
  SileroSpeechProbability,
  VadModelUnavailableError,
  type PinnedModel,
} from '../../../src/voice/vad/sileroVad';
import {
  DEFAULT_UTTERANCE_OPTIONS,
  UtteranceDetector,
  VAD_WINDOW_SAMPLES,
  type DetectorEvent,
} from '../../../src/voice/vad/utteranceDetector';
import { syntheticRecording } from '../../fixtures/voice/syntheticSpeech';

const WINDOW_MS = 32;

function windows(samples: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let offset = 0; offset + VAD_WINDOW_SAMPLES <= samples.length; offset += VAD_WINDOW_SAMPLES) {
    out.push(samples.slice(offset, offset + VAD_WINDOW_SAMPLES));
  }
  return out;
}

/** Runs the detector over probabilities given one per window: 1 where a letter is `#`, else 0. */
function detect(pattern: string, detector = new UtteranceDetector()): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  [...pattern].forEach((mark, index) => {
    events.push(
      ...detector.push({
        probability: mark === '#' ? 0.95 : 0.02,
        window: new Int16Array(VAD_WINDOW_SAMPLES).fill(index),
        endedAtMs: (index + 1) * WINDOW_MS,
      }),
    );
  });
  return events;
}

describe('UtteranceDetector', () => {
  it('ends an utterance after the closing silence and keeps the words, not the wait', () => {
    const events = detect(`${'.'.repeat(20)}${'#'.repeat(30)}${'.'.repeat(30)}`);
    expect(events.map(event => event.type)).toEqual(['speech_started', 'utterance']);
    const utterance = events[1];
    if (utterance?.type !== 'utterance') throw new Error('expected an utterance');
    expect(utterance.startedAtMs).toBeCloseTo(20 * WINDOW_MS, -1);
    expect(utterance.speechEndedAtMs).toBe(50 * WINDOW_MS);
    // Speech, plus the short pre-roll and trailing pad: well short of the 30 silent windows.
    expect(utterance.samples.length / VAD_WINDOW_SAMPLES).toBeLessThan(30 + 10 + 10 + 2);
    expect(utterance.samples.length / VAD_WINDOW_SAMPLES).toBeGreaterThanOrEqual(30);
  });

  it('does not split an utterance at a short dip', () => {
    const events = detect(`${'#'.repeat(15)}${'.'.repeat(6)}${'#'.repeat(15)}${'.'.repeat(30)}`);
    expect(events.filter(event => event.type === 'utterance')).toHaveLength(1);
  });

  it('splits two utterances separated by a long pause', () => {
    const events = detect(`${'#'.repeat(15)}${'.'.repeat(30)}${'#'.repeat(15)}${'.'.repeat(30)}`);
    expect(events.filter(event => event.type === 'utterance')).toHaveLength(2);
  });

  it('drops a click that is too short to be words', () => {
    const events = detect(`${'.'.repeat(10)}${'#'.repeat(4)}${'.'.repeat(30)}`);
    expect(events).toEqual([]);
  });

  it('needs a stronger and longer start when asked, so a quiet voice does not start it', () => {
    const detector = new UtteranceDetector();
    detector.setStrictStart({ startThreshold: 0.9, minSpeechMs: 400 });
    const events = detect(`${'#'.repeat(10)}${'.'.repeat(30)}`, detector);
    // 10 windows is 320 ms, under the 400 ms asked for.
    expect(events).toEqual([]);
  });

  it('closes an utterance that never ends', () => {
    const detector = new UtteranceDetector({ ...DEFAULT_UTTERANCE_OPTIONS, maxUtteranceMs: 1000 });
    const events = detect('#'.repeat(60), detector);
    expect(events.some(event => event.type === 'utterance')).toBe(true);
  });
});

describe('ensureVadModel', () => {
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
    const target = await ensureVadModel({ dir, pin, fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    const never: typeof fetch = () => Promise.reject(new Error('should not download again'));
    await expect(ensureVadModel({ dir, pin, fetchFile: never })).resolves.toBe(target);
  });

  it('refuses a download that is not the pinned file, and saves nothing', async () => {
    const pin = pinFor(new TextEncoder().encode('model bytes'));
    const other = new TextEncoder().encode('model bytez');
    await expect(ensureVadModel({ dir, pin, fetchFile: answer(other) })).rejects.toBeInstanceOf(
      VadModelUnavailableError,
    );
    await expect(readFile(path.join(dir, 'model.onnx'))).rejects.toThrow();
  });

  it('replaces a saved file that no longer matches the pin', async () => {
    const bytes = new TextEncoder().encode('model bytes');
    await writeFile(path.join(dir, 'model.onnx'), 'tampered');
    const target = await ensureVadModel({ dir, pin: pinFor(bytes), fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  it('says what to do when the download fails', async () => {
    const pin = pinFor(new TextEncoder().encode('x'));
    const down: typeof fetch = () => Promise.reject(new Error('offline'));
    await expect(ensureVadModel({ dir, pin, fetchFile: down })).rejects.toThrow(/internet connection/);
  });
});

describe('Silero VAD on a fixture recording', () => {
  it('finds each utterance in a recording with two sentences and pauses between', async () => {
    const cacheDir = path.join(tmpdir(), 'aman-silero-vad-test');
    const model = await SileroSpeechProbability.load({ modelPath: await ensureVadModel({ dir: cacheDir }) });
    const recording = syntheticRecording([
      { kind: 'quiet', seconds: 1.0 },
      { kind: 'speech', seconds: 1.5, pitch: 120 },
      { kind: 'quiet', seconds: 1.2 },
      { kind: 'speech', seconds: 2.0, pitch: 190 },
      { kind: 'quiet', seconds: 1.0 },
    ]);
    const detector = new UtteranceDetector();
    const found: { startMs: number; endMs: number }[] = [];
    let index = 0;
    for (const window of windows(recording)) {
      index += 1;
      const probability = await model.probability(window);
      for (const event of detector.push({ probability, window, endedAtMs: index * WINDOW_MS })) {
        if (event.type === 'utterance') {
          found.push({ startMs: event.startedAtMs, endMs: event.speechEndedAtMs });
        }
      }
    }
    expect(found).toHaveLength(2);
    const [first, second] = found;
    // Each found utterance lies on the speech that was put there, give or take a syllable.
    expect(first?.startMs).toBeGreaterThan(900);
    expect(first?.startMs).toBeLessThan(1500);
    expect(first?.endMs).toBeGreaterThan(2300);
    expect(first?.endMs).toBeLessThan(3000);
    expect(second?.startMs).toBeGreaterThan(3500);
    expect(second?.endMs).toBeGreaterThan(5300);
    expect(second?.endMs).toBeLessThan(6100);
  }, 120_000);
});
