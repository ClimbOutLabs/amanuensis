import { describe, expect, it } from 'vitest';

import {
  createSilenceDetector,
  encodeWav,
  MIN_SPEECH_MS,
  PAUSE_AFTER_SPEECH_MS,
  QUIET_TIMEOUT_MS,
  resampleLinear,
  VOICE_SAMPLE_RATE,
} from '@/atoms/lib/voiceRecorder.js';

describe('encodeWav', () => {
  it('writes a 16-bit mono WAV with the sidecar sample rate', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(samples, VOICE_SAMPLE_RATE);

    expect(blob.type).toBe('audio/wav');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(44 + samples.length * 2);
    const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');

    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-16383);
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32767);
  });
});

describe('resampleLinear', () => {
  it('returns the input unchanged when the rates match', () => {
    const samples = new Float32Array([1, 2, 3]);
    expect(resampleLinear(samples, { fromRate: 16000, toRate: 16000 })).toBe(samples);
  });

  it('downsamples with linear interpolation', () => {
    const samples = new Float32Array([0, 10, 20, 30]);
    const out = resampleLinear(samples, { fromRate: 4, toRate: 2 });
    expect(Array.from(out)).toEqual([0, 20]);
  });

  it('upsamples with linear interpolation', () => {
    const samples = new Float32Array([0, 10]);
    const out = resampleLinear(samples, { fromRate: 1, toRate: 2 });
    expect(Array.from(out)).toEqual([0, 5, 10, 10]);
  });
});

describe('createSilenceDetector', () => {
  const RATE = 1000;
  const loud = (ms: number) => new Float32Array(ms).fill(0.2);
  const quiet = (ms: number) => new Float32Array(ms);

  it('reports a pause once speech has been heard and then stops', () => {
    const detect = createSilenceDetector(RATE);
    expect(detect(loud(MIN_SPEECH_MS))).toBeNull();
    expect(detect(quiet(PAUSE_AFTER_SPEECH_MS - 1))).toBeNull();
    expect(detect(quiet(1))).toBe('pause');
    // Reports once.
    expect(detect(quiet(PAUSE_AFTER_SPEECH_MS))).toBeNull();
  });

  it('a short sound is not speech, and talking again resets the pause', () => {
    const detect = createSilenceDetector(RATE);
    expect(detect(loud(MIN_SPEECH_MS - 1))).toBeNull();
    expect(detect(quiet(PAUSE_AFTER_SPEECH_MS))).toBeNull();
    expect(detect(loud(10))).toBeNull();
    expect(detect(quiet(PAUSE_AFTER_SPEECH_MS - 1))).toBeNull();
    expect(detect(loud(10))).toBeNull();
    expect(detect(quiet(PAUSE_AFTER_SPEECH_MS))).toBe('pause');
  });

  it('reports quiet when nobody speaks at all', () => {
    const detect = createSilenceDetector(RATE);
    expect(detect(quiet(QUIET_TIMEOUT_MS - 1))).toBeNull();
    expect(detect(quiet(1))).toBe('quiet');
  });
});
