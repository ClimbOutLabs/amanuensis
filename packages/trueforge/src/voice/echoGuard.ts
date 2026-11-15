/**
 * What the assistant is playing right now, and how to tell its own voice from the person's.
 *
 * The browser removes most echo itself. This is the second line: the engine knows exactly what it
 * sent, so it can see when the microphone is only carrying that back (the loudness rises and falls
 * with the reference), and it remembers the words it said so a heard sentence that is only those
 * words can be set aside.
 */
import { OUTPUT_SAMPLE_RATE, outputToSamples, rms, type OutputFormat } from './audio';

/** Nothing is taken as an approval while the assistant speaks, or for this long after. */
export const APPROVAL_GUARD_MS = 1500;
/** One loudness reading covers this much audio; it matches the listening window. */
export const ENVELOPE_FRAME_MS = 32;
/** The microphone may hear the speaker this much later than it was sent (buffering and the room). */
const MAX_ECHO_DELAY_MS = 800;
const CORRELATION_WINDOW_FRAMES = 10;
const ECHO_CORRELATION = 0.8;
/** Reference loudness below this is silence, which no echo can follow. */
const MIN_REFERENCE_RMS = 0.01;
const SPOKEN_TEXT_MEMORY_MS = 60_000;

export interface Clock {
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

export class PlaybackTimeline {
  readonly #clock: Clock;
  readonly #format: OutputFormat;
  /** Loudness of what was sent, by the frame of the wall clock it plays in. */
  readonly #reference = new Map<number, number>();
  #endsAtMs = 0;
  #lastSpokeAtMs = Number.NEGATIVE_INFINITY;

  constructor({ clock, format }: { clock: Clock; format: OutputFormat }) {
    this.#clock = clock;
    this.#format = format;
  }

  /** Records a piece of audio as queued behind whatever is already playing. */
  schedule(bytes: Uint8Array): void {
    const now = this.#clock.now();
    const samples = outputToSamples({ bytes, format: this.#format });
    const rate = OUTPUT_SAMPLE_RATE[this.#format];
    const startMs = Math.max(now, this.#endsAtMs);
    const frameSamples = Math.round((rate * ENVELOPE_FRAME_MS) / 1000);
    for (let offset = 0; offset < samples.length; offset += frameSamples) {
      const atMs = startMs + (offset / rate) * 1000;
      this.#reference.set(Math.floor(atMs / ENVELOPE_FRAME_MS), rms(samples.subarray(offset, offset + frameSamples)));
    }
    this.#endsAtMs = startMs + (samples.length / rate) * 1000;
    this.#lastSpokeAtMs = this.#endsAtMs;
    this.#forgetOld(now);
  }

  /** Playback was stopped at once: nothing queued will be heard. */
  stop(): void {
    const now = this.#clock.now();
    this.#endsAtMs = Math.min(this.#endsAtMs, now);
    this.#lastSpokeAtMs = now;
  }

  isPlaying(atMs: number = this.#clock.now()): boolean {
    return atMs < this.#endsAtMs;
  }

  /** When the last queued audio finishes; already past when nothing is playing. */
  get endsAtMs(): number {
    return this.#endsAtMs;
  }

  /** Playing now, or stopped within the approval guard time. */
  inGuard(atMs: number = this.#clock.now()): boolean {
    return atMs < this.#endsAtMs || atMs < this.#lastSpokeAtMs + APPROVAL_GUARD_MS;
  }

  /**
   * True when the recent microphone loudness (one reading per frame, newest last, the newest heard at
   * `atMs`) follows the loudness of what was sent, at some small delay.
   */
  followsPlayback({ recentInputRms, atMs }: { recentInputRms: readonly number[]; atMs: number }): boolean {
    if (recentInputRms.length < CORRELATION_WINDOW_FRAMES) {
      return false;
    }
    const input = recentInputRms.slice(-CORRELATION_WINDOW_FRAMES);
    const nowFrame = Math.floor(atMs / ENVELOPE_FRAME_MS);
    const maxLagFrames = Math.ceil(MAX_ECHO_DELAY_MS / ENVELOPE_FRAME_MS);
    for (let lag = 0; lag <= maxLagFrames; lag += 1) {
      const reference = input.map((_, index) => {
        const frame = nowFrame - (CORRELATION_WINDOW_FRAMES - 1 - index) - lag;
        return this.#reference.get(frame) ?? 0;
      });
      if (mean(reference) >= MIN_REFERENCE_RMS && similarLoudness({ input, reference })) {
        return true;
      }
    }
    return false;
  }

  #forgetOld(now: number): void {
    const oldest = Math.floor((now - 10_000) / ENVELOPE_FRAME_MS);
    for (const frame of this.#reference.keys()) {
      if (frame < oldest) {
        this.#reference.delete(frame);
      }
    }
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function similarLoudness({ input, reference }: { input: readonly number[]; reference: readonly number[] }): boolean {
  const inputMean = mean(input);
  const referenceMean = mean(reference);
  let covariance = 0;
  let inputVariance = 0;
  let referenceVariance = 0;
  input.forEach((value, index) => {
    const a = value - inputMean;
    const b = (reference[index] ?? 0) - referenceMean;
    covariance += a * b;
    inputVariance += a * a;
    referenceVariance += b * b;
  });
  if (inputMean < MIN_REFERENCE_RMS / 4) {
    return false;
  }
  const flatInput = Math.sqrt(inputVariance / input.length) < inputMean * 0.05;
  const flatReference = Math.sqrt(referenceVariance / input.length) < referenceMean * 0.05;
  if (flatInput || flatReference) {
    // A steady tone has no shape to compare, so both being steady is the only echo sign there is.
    return flatInput && flatReference;
  }
  return covariance / Math.sqrt(inputVariance * referenceVariance) >= ECHO_CORRELATION;
}

export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(word => word !== '');
}

/** The words the assistant just said, so a heard sentence that only repeats them can be told apart. */
export class SpokenTextLog {
  readonly #clock: Clock;
  #entries: { atMs: number; words: string[] }[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** `lastHeardAtMs` is when the last of the text finishes playing; the words are remembered from then. */
  add({ text, lastHeardAtMs }: { text: string; lastHeardAtMs?: number }): void {
    const now = this.#clock.now();
    this.#entries = this.#entries.filter(entry => now - entry.atMs < SPOKEN_TEXT_MEMORY_MS);
    this.#entries.push({ atMs: lastHeardAtMs ?? now, words: wordsOf(text) });
  }

  /**
   * True when the heard words are a run inside what was said, or nearly all come from it. A few words
   * are said by anyone, so fewer than `minWords` never counts as a repeat.
   */
  repeats({ heard, minWords = 1 }: { heard: string; minWords?: number }): boolean {
    const now = this.#clock.now();
    const heardWords = wordsOf(heard);
    if (heardWords.length === 0 || heardWords.length < minWords) {
      return false;
    }
    const spoken = this.#entries
      .filter(entry => now - entry.atMs < SPOKEN_TEXT_MEMORY_MS)
      .flatMap(entry => entry.words);
    const spokenText = ` ${spoken.join(' ')} `;
    if (spokenText.includes(` ${heardWords.join(' ')} `)) {
      return true;
    }
    if (heardWords.length < 3) {
      return false;
    }
    const known = new Set(spoken);
    return heardWords.filter(word => known.has(word)).length / heardWords.length >= 0.7;
  }
}
