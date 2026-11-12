/** Stand-ins for the parts a voice session talks to, plus a loop that can play the assistant back into the microphone. */
import type { InputFormat, OutputFormat } from '../../../src/voice/audio';
import { OUTPUT_SAMPLE_RATE, outputToSamples } from '../../../src/voice/audio';
import type { Clock } from '../../../src/voice/echoGuard';
import type { LatencyDriver } from '../../../src/voice/latencyHarness';
import type { VoiceSession } from '../../../src/voice/session';
import type {
  PendingApproval,
  SpeechSynthesizer,
  SpeechToText,
  TurnOutcome,
  VoiceEvent,
  VoiceTransport,
  VoiceTurnRunner,
} from '../../../src/voice/transport';
import { UncheckedSpeechError, WouldChangeTextError } from '../../../src/voice/transport';
import type { SpeechProbability } from '../../../src/voice/vad/sileroVad';
import { VAD_WINDOW_SAMPLES } from '../../../src/voice/vad/utteranceDetector';

export class ManualClock implements Clock {
  #now = 1_000_000;
  #timers: { at: number; run: () => void }[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, run: () => void): () => void {
    const timer = { at: this.#now + ms, run };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter(candidate => candidate !== timer);
    };
  }

  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter(timer => timer.at <= this.#now);
    this.#timers = this.#timers.filter(timer => timer.at > this.#now);
    due.forEach(timer => {
      timer.run();
    });
  }
}

/** Loudness stands in for the speech model: loud is speech. */
export class LoudnessVad implements SpeechProbability {
  probability(window: Int16Array): Promise<number> {
    let sum = 0;
    for (const sample of window) {
      sum += (sample / 32768) ** 2;
    }
    return Promise.resolve(Math.sqrt(sum / window.length) > 0.03 ? 0.95 : 0.02);
  }
  reset(): void {
    // No running state to clear.
  }
}

export class FakeTransport implements VoiceTransport {
  readonly events: VoiceEvent[] = [];
  readonly audio: { atMs: number; bytes: Uint8Array }[] = [];
  cleared = 0;
  closed = false;
  readonly #clock: Clock;

  constructor(
    readonly options: {
      clock: Clock;
      voiceApprovals: boolean;
      outputFormat?: OutputFormat;
      inputFormat?: InputFormat;
    },
  ) {
    this.#clock = options.clock;
  }

  get outputFormat(): OutputFormat {
    return this.options.outputFormat ?? 'pcm16';
  }
  get inputFormat(): InputFormat {
    return this.options.inputFormat ?? 'pcm16_16k';
  }
  get voiceApprovals(): boolean {
    return this.options.voiceApprovals;
  }
  sendAudio(chunk: Uint8Array): void {
    this.audio.push({ atMs: this.#clock.now(), bytes: chunk });
  }
  clearAudio(): void {
    this.cleared += 1;
    this.audio.length = 0;
  }
  sendEvent(event: VoiceEvent): void {
    this.events.push(event);
  }
  close(): void {
    this.closed = true;
  }
  states(): string[] {
    return this.events.flatMap(event => (event.type === 'state' ? [event.state] : []));
  }
  heard(): string[] {
    return this.events.flatMap(event => (event.type === 'heard' ? [event.text] : []));
  }
}

export class FakeStt implements SpeechToText {
  readonly #answers: string[];
  calls = 0;
  /** While true, a call waits (until its signal aborts) instead of answering. */
  hold = false;
  readonly #held: ((text: string) => void)[] = [];
  constructor(...answers: string[]) {
    this.#answers = answers;
  }
  /** Answers every call that is waiting with this text. */
  release(text: string): void {
    for (const resolve of this.#held.splice(0)) {
      resolve(text);
    }
  }

  transcribe({ signal }: { signal: AbortSignal }): Promise<string> {
    this.calls += 1;
    if (this.hold) {
      return new Promise((resolve, reject) => {
        this.#held.push(resolve);
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('stopped'));
          },
          { once: true },
        );
      });
    }
    return Promise.resolve(this.#answers.shift() ?? '');
  }
}

/** Each sentence is half a second of a pulsing tone, handed over in four pieces. */
export class FakeTts implements SpeechSynthesizer {
  readonly sentences: string[] = [];
  /** Every text the voice was asked to say exactly, in order. */
  readonly asked: string[] = [];
  /** The stop signal each text was made under, so a test can see which lines were cut off. */
  readonly signals = new Map<string, AbortSignal>();
  constructor(
    private readonly options: {
      /** Waits before a text is made, so a test can hold one line back. */
      delay?: ((text: string) => Promise<void>) | undefined;
      failOn?: ((text: string) => boolean) | undefined;
      silentOn?: ((text: string) => boolean) | undefined;
      /** Texts the voice would say differently from how they are written. */
      changes?: ((text: string) => boolean) | undefined;
      /** The voice cannot be reached to check a text it is asked to say exactly. */
      cannotCheck?: boolean | undefined;
      /** The voice service answers an exact request without having checked the words. */
      unchecked?: boolean | undefined;
    } = {},
  ) {}

  async *stream({
    text,
    format,
    signal,
    exact = false,
  }: {
    text: string;
    format: OutputFormat;
    signal: AbortSignal;
    exact?: boolean;
  }): AsyncIterable<Uint8Array> {
    if (exact) {
      this.asked.push(text);
      if (this.options.cannotCheck === true) {
        throw new Error('the voice is not answering');
      }
      if (this.options.unchecked === true) {
        throw new UncheckedSpeechError();
      }
      if (this.options.changes?.(text) === true) {
        throw new WouldChangeTextError();
      }
    }
    this.sentences.push(text);
    this.signals.set(text, signal);
    await this.options.delay?.(text);
    if (this.options.failOn?.(text) === true) {
      throw new Error('the voice stopped');
    }
    if (this.options.silentOn?.(text) === true) {
      return;
    }
    const rate = OUTPUT_SAMPLE_RATE[format];
    const total = Math.round(rate * 0.5);
    const piece = Math.round(total / 4);
    for (let start = 0; start < total; start += piece) {
      if (signal.aborted) {
        return;
      }
      const samples = new Int16Array(piece);
      for (let n = 0; n < piece; n += 1) {
        const t = (start + n) / rate;
        samples[n] = Math.round(
          Math.sin(2 * Math.PI * 200 * t) * (0.15 + 0.15 * Math.sin(2 * Math.PI * 5 * t)) * 32767,
        );
      }
      yield format === 'pcm16' ? pcmBytes(samples) : mulawBytes(samples);
      await Promise.resolve();
    }
  }
}

export function pcmBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return out;
}

/** G.711 mu-law for a test signal; the engine only ever decodes. */
export function mulawBytes(samples: Int16Array): Uint8Array {
  return Uint8Array.from(samples, sample => {
    const sign = sample < 0 ? 0x80 : 0;
    const magnitude = Math.min(Math.abs(sample), 32635) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
      exponent -= 1;
    }
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
  });
}

export interface ScriptedReply {
  /** Pieces of reply text, streamed in order. */
  text?: string[];
  approvals?: PendingApproval[];
  outcome?: TurnOutcome['kind'];
  refusal?: 'expired' | 'changed' | 'not_allowed' | 'tool_gone' | 'sign_in';
}

export class FakeTurns implements VoiceTurnRunner {
  readonly sent: string[] = [];
  readonly answers: { decision: 'allow' | 'deny'; toolCallId: string }[] = [];
  cancels = 0;
  /** Cards answered somewhere else, such as on the screen. */
  readonly settledElsewhere = new Set<string>();
  #count = 0;
  constructor(
    private readonly replies: { message?: ScriptedReply[]; approval?: ScriptedReply[] } = {},
    private readonly options: {
      gate?: (() => Promise<void>) | undefined;
      /** Holds the turn open after its words came, as a long tool run does. */
      holdAfterText?: (() => Promise<void>) | undefined;
    } = {},
  ) {}

  async sendMessage({ text, signal, onText }: { text: string; signal: AbortSignal; onText: (delta: string) => void }) {
    this.sent.push(text);
    return this.#run({ reply: this.replies.message?.shift(), signal, onText });
  }

  async answerApproval({
    approval,
    decision,
    signal,
    onText,
  }: {
    approval: PendingApproval;
    decision: 'allow' | 'deny';
    signal: AbortSignal;
    onText: (delta: string) => void;
  }) {
    this.answers.push({ decision, toolCallId: approval.toolCallId });
    return this.#run({ reply: this.replies.approval?.shift(), signal, onText });
  }

  stillWaiting({ approval }: { approval: PendingApproval }): Promise<boolean> {
    return Promise.resolve(!this.settledElsewhere.has(approval.toolCallId));
  }

  cancel(): Promise<void> {
    this.cancels += 1;
    return Promise.resolve();
  }

  async #run({
    reply,
    signal,
    onText,
  }: {
    reply: ScriptedReply | undefined;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    await this.options.gate?.();
    for (const piece of reply?.text ?? []) {
      if (signal.aborted) {
        return { kind: 'failed' };
      }
      onText(piece);
      await Promise.resolve();
    }
    await this.options.holdAfterText?.();
    if (reply?.outcome === 'refused' && reply.refusal !== undefined) {
      return { kind: 'refused', reason: reply.refusal };
    }
    this.#count += 1;
    return { kind: 'done', turnId: `turn-${String(this.#count)}`, approvals: reply?.approvals ?? [] };
  }
}

const tick = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

/** Quiet, or a pulsing hum loud enough to count as speech. */
export function hum(ms: number, level = 0.3, wobbleHz = 2.3): Int16Array {
  const out = new Int16Array(Math.round((16_000 * ms) / 1000));
  for (let n = 0; n < out.length; n += 1) {
    const t = n / 16_000;
    out[n] = Math.round(
      Math.sin(2 * Math.PI * 180 * t) * level * (0.6 + 0.4 * Math.sin(2 * Math.PI * wobbleHz * t)) * 32767,
    );
  }
  return out;
}
export const quiet = (ms: number): Int16Array => new Int16Array(Math.round((16_000 * ms) / 1000));

/** Plays what the assistant sent back into the microphone, quieter and a little late, like a speaker near a mic. */
export class Loopback {
  /** What was queued for playback, in the wall clock it plays at. */
  readonly #played: { startMs: number; samples: Int16Array; rate: number }[] = [];
  #endsAtMs = 0;
  #seen = 0;
  #clearedSeen = 0;

  constructor(
    private readonly transport: FakeTransport,
    private readonly clock: Clock,
    private readonly options: { gain: number; delayMs: number },
  ) {}

  #collect(): void {
    if (this.transport.cleared !== this.#clearedSeen) {
      // The line dropped what was queued, so the speaker goes quiet.
      this.#clearedSeen = this.transport.cleared;
      this.#played.length = 0;
      this.#endsAtMs = this.clock.now();
      this.#seen = 0;
    }
    for (; this.#seen < this.transport.audio.length; this.#seen += 1) {
      const entry = this.transport.audio[this.#seen];
      if (entry === undefined) {
        continue;
      }
      const samples = outputToSamples({ bytes: entry.bytes, format: this.transport.outputFormat });
      const rate = OUTPUT_SAMPLE_RATE[this.transport.outputFormat];
      const startMs = Math.max(entry.atMs, this.#endsAtMs);
      this.#played.push({ startMs, samples, rate });
      this.#endsAtMs = startMs + (samples.length / rate) * 1000;
    }
    this.#seen = Math.min(this.#seen, this.transport.audio.length);
  }

  /** The echo for the window that starts now, ready to be added to what the person says. */
  window(): Int16Array {
    this.#collect();
    const out = new Int16Array(VAD_WINDOW_SAMPLES);
    const now = this.clock.now();
    for (let n = 0; n < out.length; n += 1) {
      const t = now + (n / 16_000) * 1000 - this.options.delayMs;
      const piece = this.#played.find(
        candidate =>
          t >= candidate.startMs && t < candidate.startMs + (candidate.samples.length / candidate.rate) * 1000,
      );
      if (piece !== undefined) {
        out[n] = Math.round(
          (piece.samples[Math.floor(((t - piece.startMs) / 1000) * piece.rate)] ?? 0) * this.options.gain,
        );
      }
    }
    return out;
  }
}

/** Feeds audio window by window, one wall-clock step each, with the engine given time to react. */
export async function feed({
  session,
  clock,
  samples,
  echo,
}: {
  session: VoiceSession;
  clock: ManualClock;
  samples: Int16Array;
  echo?: Loopback;
}): Promise<void> {
  for (let offset = 0; offset + VAD_WINDOW_SAMPLES <= samples.length; offset += VAD_WINDOW_SAMPLES) {
    const window = samples.slice(offset, offset + VAD_WINDOW_SAMPLES);
    const back = echo?.window();
    if (back !== undefined) {
      window.forEach((sample, index) => {
        window[index] = Math.max(-32768, Math.min(32767, sample + (back[index] ?? 0)));
      });
    }
    session.pushAudio(pcmBytes(window));
    clock.advance(32);
    await tick();
    await tick();
  }
}

/** Lets queued promise work finish, so a step of virtual time sees everything that step set off. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }
}

/** A promise that is done after `ms` of the clock's time, not of the machine's. */
export function delay({ clock, ms }: { clock: Clock; ms: number }): Promise<void> {
  return new Promise(resolve => {
    clock.after(ms, resolve);
  });
}

/**
 * Drives the latency harness on a virtual clock: a pause moves the clock and lets the work it wakes finish, so a
 * trial takes no real time and its split depends only on the audio. `stall` jumps the clock once, after the given
 * number of pauses, as a process stall would.
 */
export function virtualDriver({ stall }: { stall?: { afterPauses: number; ms: number } } = {}): LatencyDriver {
  const clock = new ManualClock();
  let pauses = 0;
  return {
    clock,
    pause: async ms => {
      pauses += 1;
      clock.advance(ms);
      if (pauses === stall?.afterPauses) {
        clock.advance(stall.ms);
      }
      await settle();
    },
  };
}
