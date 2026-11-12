/**
 * Turns a stream of per-window speech probabilities into whole utterances.
 *
 * Pure and clock-free: the caller says when each window ended. Speech starts once the probability
 * stays high for `minSpeechMs`, and ends after `endSilenceMs` of quiet. The audio just before the
 * start is kept so the first syllable is not cut. A stricter start can be asked for while the
 * assistant is speaking, so its own voice is less likely to start an utterance.
 */
import { INPUT_SAMPLE_RATE } from '../audio';

/** The window the speech model reads: 512 samples, 32 ms at 16 kHz. */
export const VAD_WINDOW_SAMPLES = 512;
const WINDOW_MS = (VAD_WINDOW_SAMPLES / INPUT_SAMPLE_RATE) * 1000;

export interface UtteranceDetectorOptions {
  startThreshold: number;
  /** Lower than the start threshold, so one dip inside a word does not end it. */
  endThreshold: number;
  minSpeechMs: number;
  endSilenceMs: number;
  preRollMs: number;
  maxUtteranceMs: number;
}

export const DEFAULT_UTTERANCE_OPTIONS: UtteranceDetectorOptions = {
  startThreshold: 0.5,
  endThreshold: 0.35,
  minSpeechMs: 250,
  endSilenceMs: 600,
  preRollMs: 320,
  maxUtteranceMs: 30_000,
};

export type DetectorEvent =
  | { type: 'speech_started'; startedAtMs: number }
  | { type: 'utterance'; samples: Int16Array; startedAtMs: number; speechEndedAtMs: number }
  /** Speech too brief to be words: a cough, a click. Nothing is sent on. */
  | { type: 'dropped' };

export interface StrictStart {
  startThreshold: number;
  minSpeechMs: number;
}

interface Heard {
  window: Int16Array;
  endedAtMs: number;
}

export class UtteranceDetector {
  readonly #options: UtteranceDetectorOptions;
  #strict: StrictStart | undefined;
  /** Recent windows while idle; the oldest fall away. */
  #recent: Heard[] = [];
  /** Windows since the probability first rose, before speech is confirmed. */
  #candidate: Heard[] = [];
  #collected: Heard[] = [];
  #speaking = false;
  #silenceMs = 0;
  #lastSpeechEndedAtMs = 0;
  #speechStartedAtMs = 0;

  constructor(options: UtteranceDetectorOptions = DEFAULT_UTTERANCE_OPTIONS) {
    this.#options = options;
  }

  /** A stricter start for as long as it is set; `undefined` goes back to the usual one. */
  setStrictStart(strict: StrictStart | undefined): void {
    this.#strict = strict;
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  reset(): void {
    this.#recent = [];
    this.#candidate = [];
    this.#collected = [];
    this.#speaking = false;
    this.#silenceMs = 0;
  }

  push({
    probability,
    window,
    endedAtMs,
  }: {
    probability: number;
    window: Int16Array;
    endedAtMs: number;
  }): DetectorEvent[] {
    const heard: Heard = { window, endedAtMs };
    return this.#speaking ? this.#whileSpeaking({ probability, heard }) : this.#whileIdle({ probability, heard });
  }

  #whileIdle({ probability, heard }: { probability: number; heard: Heard }): DetectorEvent[] {
    const start = this.#strict?.startThreshold ?? this.#options.startThreshold;
    const minSpeechMs = this.#strict?.minSpeechMs ?? this.#options.minSpeechMs;
    // A strict start holds every window to the strict threshold, not only the first.
    const rising =
      this.#candidate.length > 0 && this.#strict === undefined
        ? probability >= this.#options.endThreshold
        : probability >= start;
    if (!rising) {
      this.#recent.push(...this.#candidate, heard);
      this.#candidate = [];
      this.#trimRecent();
      return [];
    }
    this.#candidate.push(heard);
    if (this.#candidate.length * WINDOW_MS < minSpeechMs) {
      return [];
    }
    this.#speaking = true;
    this.#silenceMs = 0;
    this.#collected = [...this.#recent, ...this.#candidate];
    this.#lastSpeechEndedAtMs = heard.endedAtMs;
    const first = this.#candidate[0];
    const startedAtMs = (first?.endedAtMs ?? heard.endedAtMs) - WINDOW_MS;
    this.#speechStartedAtMs = startedAtMs;
    this.#recent = [];
    this.#candidate = [];
    return [{ type: 'speech_started', startedAtMs }];
  }

  #whileSpeaking({ probability, heard }: { probability: number; heard: Heard }): DetectorEvent[] {
    this.#collected.push(heard);
    if (probability >= this.#options.endThreshold) {
      this.#silenceMs = 0;
      this.#lastSpeechEndedAtMs = heard.endedAtMs;
    } else {
      this.#silenceMs += WINDOW_MS;
    }
    const collectedMs = this.#collected.length * WINDOW_MS;
    if (this.#silenceMs < this.#options.endSilenceMs && collectedMs < this.#options.maxUtteranceMs) {
      return [];
    }
    return [this.#finish()];
  }

  #finish(): DetectorEvent {
    const collected = this.#collected;
    const speechEndedAtMs = this.#lastSpeechEndedAtMs;
    const first = collected[0];
    this.#speaking = false;
    this.#collected = [];
    this.#silenceMs = 0;
    const speechMs = collected.filter(heard => heard.endedAtMs <= speechEndedAtMs).length * WINDOW_MS;
    if (first === undefined || speechMs < this.#options.minSpeechMs) {
      return { type: 'dropped' };
    }
    // Keep a little quiet after the last word; the rest of the wait is dropped.
    const keepUntil = speechEndedAtMs + this.#options.preRollMs;
    const kept = collected.filter(heard => heard.endedAtMs <= keepUntil);
    const samples = new Int16Array(kept.length * VAD_WINDOW_SAMPLES);
    kept.forEach((heard, index) => {
      samples.set(heard.window, index * VAD_WINDOW_SAMPLES);
    });
    return { type: 'utterance', samples, startedAtMs: this.#speechStartedAtMs, speechEndedAtMs };
  }

  #trimRecent(): void {
    const keep = Math.ceil(this.#options.preRollMs / WINDOW_MS);
    if (this.#recent.length > keep) {
      this.#recent.splice(0, this.#recent.length - keep);
    }
  }
}
