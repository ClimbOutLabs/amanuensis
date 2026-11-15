/**
 * Made-up speech for the voice tests: a pulse train shaped by vowel resonances and a slow syllable
 * rhythm. It is not a recording of anyone, and the speech model still reads it as speech.
 * Used only by the `voice:latency` script and the tests that call it.
 */
const RATE = 16_000;

type Formant = readonly [frequency: number, bandwidth: number, gain: number];
const VOWELS: readonly (readonly Formant[])[] = [
  [
    [700, 90, 1],
    [1200, 110, 0.6],
    [2600, 160, 0.3],
  ],
  [
    [300, 60, 1],
    [2300, 150, 0.7],
    [3000, 200, 0.3],
  ],
  [
    [450, 70, 1],
    [900, 90, 0.7],
    [2500, 160, 0.25],
  ],
];

function resonate({
  input,
  frequency,
  bandwidth,
}: {
  input: Float64Array;
  frequency: number;
  bandwidth: number;
}): Float64Array {
  const r = Math.exp((-Math.PI * bandwidth) / RATE);
  const a1 = -2 * r * Math.cos((2 * Math.PI * frequency) / RATE);
  const a2 = r * r;
  const out = new Float64Array(input.length);
  for (let n = 0; n < input.length; n += 1) {
    out[n] = (input[n] ?? 0) - a1 * (out[n - 1] ?? 0) - a2 * (out[n - 2] ?? 0);
  }
  return out;
}

function syllable({ seconds, pitch, vowel }: { seconds: number; pitch: number; vowel: number }): Float64Array {
  const length = Math.floor(seconds * RATE);
  const source = new Float64Array(length);
  let phase = 0;
  let previous = 0;
  for (let n = 0; n < length; n += 1) {
    const t = n / RATE;
    phase += (pitch * (1 + 0.08 * Math.sin(2 * Math.PI * 3 * t)) * (1 - (0.1 * t) / seconds)) / RATE;
    const pulse = phase % 1 < 0.02 ? 1 : 0;
    const level = pulse - 0.02;
    source[n] = level - previous;
    previous = level;
  }
  const out = new Float64Array(length);
  for (const [frequency, bandwidth, gain] of VOWELS[vowel % VOWELS.length] ?? []) {
    const shaped = resonate({ input: source, frequency, bandwidth });
    for (let n = 0; n < length; n += 1) {
      out[n] = (out[n] ?? 0) + (shaped[n] ?? 0) * gain;
    }
  }
  for (let n = 0; n < length; n += 1) {
    out[n] = (out[n] ?? 0) * Math.sin((Math.PI * n) / length) ** 0.7;
  }
  return out;
}

/** Quiet room noise, from a fixed seed so every run is the same. */
function quiet({ seconds, seed }: { seconds: number; seed: number }): Float64Array {
  let state = seed;
  const out = new Float64Array(Math.floor(seconds * RATE));
  for (let n = 0; n < out.length; n += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    out[n] = (state / 4294967296 - 0.5) * 2 * 0.004;
  }
  return out;
}

export interface SpeechPart {
  kind: 'quiet' | 'speech';
  seconds: number;
  /** Voice pitch for speech parts, in Hz. */
  pitch?: number;
}

/** A 16 kHz recording of the parts in order, as 16-bit samples. */
export function syntheticRecording(parts: readonly SpeechPart[]): Int16Array {
  const pieces = parts.map((part, index) => {
    if (part.kind === 'quiet') {
      return quiet({ seconds: part.seconds, seed: index + 1 });
    }
    const syllables = Math.max(1, Math.round(part.seconds / 0.25));
    const sounds: Float64Array[] = [];
    for (let i = 0; i < syllables; i += 1) {
      sounds.push(syllable({ seconds: 0.22, pitch: (part.pitch ?? 120) * (1 + 0.05 * i), vowel: i }));
      sounds.push(new Float64Array(Math.floor(0.03 * RATE)));
    }
    return concat(sounds);
  });
  const all = concat(pieces);
  let peak = 0;
  for (const value of all) {
    peak = Math.max(peak, Math.abs(value));
  }
  const out = new Int16Array(all.length);
  for (let n = 0; n < all.length; n += 1) {
    out[n] = Math.round(((all[n] ?? 0) / Math.max(peak, 1e-9)) * 0.5 * 32767);
  }
  return out;
}

function concat(pieces: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

export const SYNTHETIC_RATE = RATE;
