/**
 * The voice session engine: the one owner of a spoken conversation, whatever line it arrives on.
 *
 * Audio comes in, a speech model finds each utterance, the words go through the same chat turn a
 * typed message would, and the reply is spoken sentence by sentence. The person can interrupt, and
 * an approval card can be answered by an exact phrase. The engine never trusts what it hears while
 * it is speaking itself (see echoGuard.ts).
 */
import {
  APPROVAL_LINES,
  classifyAnswer,
  planVoiceApproval,
  type ApprovalVerb,
  type VoiceApprovalPlan,
} from './approvalVoice';
import { InputDecoder, rms } from './audio';
import { PlaybackTimeline, SpokenTextLog, systemClock, type Clock } from './echoGuard';
import { SentenceSplitter } from './sentences';
import { SpeechOutput } from './speechOutput';
import type {
  PendingApproval,
  SpeechSynthesizer,
  SpeechToText,
  TurnOutcome,
  TurnRefusal,
  VoiceState,
  VoiceTransport,
  VoiceTurnRunner,
} from './transport';
import type { SpeechProbability } from './vad/sileroVad';
import {
  DEFAULT_UTTERANCE_OPTIONS,
  UtteranceDetector,
  VAD_WINDOW_SAMPLES,
  type DetectorEvent,
  type StrictStart,
  type UtteranceDetectorOptions,
} from './vad/utteranceDetector';

/** Speech that starts over the assistant must be this sure, and last this long, to cut it off. */
const BARGE_IN_START: StrictStart = { startThreshold: 0.7, minSpeechMs: 400 };
/** Most of one reply that is read aloud; the rest stays in the chat. */
const MAX_SPOKEN_CHARS = 1500;
const INPUT_LEVELS_KEPT = 40;

const REFUSAL_LINES: Record<TurnRefusal, string> = {
  changed: APPROVAL_LINES.changed,
  expired: APPROVAL_LINES.expired,
  not_allowed: APPROVAL_LINES.notAllowed,
  tool_gone: APPROVAL_LINES.notAllowed,
  sign_in: APPROVAL_LINES.couldNot,
};

/** Where the time went for one turn, from the end of the person's speech to the first sound. */
export interface TurnLatency {
  /** The wait for the speech model to decide the person had finished. */
  endpointing_ms: number;
  speech_to_text_ms: number;
  /** From the words arriving to the first sentence of the reply. */
  reply_first_sentence_ms: number;
  /** From the first sentence to the first sound. */
  voice_first_audio_ms: number;
  /** End of speech to first audio: the number the 2 second target is about. */
  total_ms: number;
}

export interface VoiceSessionDeps {
  transport: VoiceTransport;
  vad: SpeechProbability;
  stt: SpeechToText;
  tts: SpeechSynthesizer;
  turns: VoiceTurnRunner;
  clock?: Clock;
  detector?: UtteranceDetectorOptions;
  /** Called with timings only, never with words. */
  onLatency?: (latency: TurnLatency) => void;
  /** Called with a short reason code and no words, for the logs. */
  onNote?: (note: string) => void;
}

interface Awaiting {
  approval: PendingApproval;
  verb: ApprovalVerb;
  reminded: boolean;
}

interface Heard {
  samples: Int16Array;
  startedAtMs: number;
  speechEndedAtMs: number;
  /** The speech began while the assistant was speaking or just after: never taken as an approval. */
  startedInGuard: boolean;
  /** The speech began while a line that holds the floor was still playing. */
  startedOverHeldLine: boolean;
}

interface Marks {
  speechEndedAtMs: number;
  utteranceAtMs: number;
  transcribedAtMs?: number;
  firstSentenceAtMs?: number;
  firstAudioAtMs?: number;
}

export class VoiceSession {
  readonly #deps: VoiceSessionDeps;
  readonly #clock: Clock;
  readonly #decoder: InputDecoder;
  readonly #detector: UtteranceDetector;
  readonly #timeline: PlaybackTimeline;
  readonly #spoken: SpokenTextLog;
  readonly #inputLevels: number[] = [];
  #samples = new Int16Array(0);
  #audioChain: Promise<void> = Promise.resolve();
  #turnChain: Promise<void> = Promise.resolve();
  #turnAbort: AbortController | undefined;
  #cancelling: Promise<void> = Promise.resolve();
  #guardAtSpeechStart = false;
  #overHeldLineAtSpeechStart = false;
  /** A line that holds the floor is being handed over, or plays until this time. */
  #floorHeld = false;
  #floorUntilMs = Number.NEGATIVE_INFINITY;
  #lineAbort: AbortController | undefined;
  #awaiting: Awaiting | undefined;
  #state: VoiceState = 'listening';
  #busy = false;
  #ended = false;
  #cancelStateCheck: (() => void) | undefined;

  constructor(deps: VoiceSessionDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#decoder = new InputDecoder(deps.transport.inputFormat);
    this.#detector = new UtteranceDetector(deps.detector ?? DEFAULT_UTTERANCE_OPTIONS);
    this.#timeline = new PlaybackTimeline({ clock: this.#clock, format: deps.transport.outputFormat });
    this.#spoken = new SpokenTextLog(this.#clock);
  }

  start(): void {
    this.#deps.transport.sendEvent({ type: 'state', state: 'listening' });
  }

  /** The line sent audio. It is processed in order; this returns at once. */
  pushAudio(bytes: Uint8Array): void {
    if (this.#ended) {
      return;
    }
    const incoming = this.#decoder.push(bytes);
    const joined = new Int16Array(this.#samples.length + incoming.length);
    joined.set(this.#samples);
    joined.set(incoming, this.#samples.length);
    let offset = 0;
    while (joined.length - offset >= VAD_WINDOW_SAMPLES) {
      const window = joined.slice(offset, offset + VAD_WINDOW_SAMPLES);
      offset += VAD_WINDOW_SAMPLES;
      this.#audioChain = this.#audioChain.then(() => this.#onWindow(window));
    }
    this.#samples = joined.slice(offset);
  }

  /**
   * Speaks a line that no turn asked for, such as the opening of a phone call, after anything already queued. The
   * person can interrupt it like any reply, unless `interruptible` is false: then it plays to the end, and what the
   * person says over it still becomes a turn, marked as started over that line. Resolves once it has been handed to
   * the line.
   */
  say(text: string, { interruptible = true }: { interruptible?: boolean } = {}): Promise<void> {
    const spoken = this.#turnChain.then(async () => {
      if (this.#ended) {
        return;
      }
      const abort = new AbortController();
      if (interruptible) {
        this.#turnAbort = abort;
      } else {
        this.#lineAbort = abort;
        this.#floorHeld = true;
      }
      const now = this.#clock.now();
      const speech = this.#speechFor({ signal: abort.signal, marks: { speechEndedAtMs: now, utteranceAtMs: now } });
      for (const sentence of splitSentences(text)) {
        speech.say({ text: sentence, role: 'body' });
      }
      await speech.drain();
      if (this.#turnAbort === abort) {
        this.#turnAbort = undefined;
      }
      if (!interruptible) {
        this.#lineAbort = undefined;
        this.#floorHeld = false;
        this.#floorUntilMs = this.#timeline.endsAtMs;
      }
      this.#refreshState();
    });
    this.#turnChain = spoken;
    return spoken;
  }

  /** Resolves once the audio pushed so far, and the turn it started, have been dealt with. */
  async settled(): Promise<void> {
    await this.#audioChain;
    await this.#turnChain;
  }

  /** The person ended the conversation (or the line dropped). */
  async end(): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#cancelStateCheck?.();
    this.#turnAbort?.abort();
    this.#lineAbort?.abort();
    this.#timeline.stop();
    this.#deps.transport.clearAudio();
    await this.#deps.turns.cancel().catch(() => undefined);
    this.#deps.vad.reset();
    this.#deps.transport.close();
  }

  async #onWindow(window: Int16Array): Promise<void> {
    if (this.#ended) {
      return;
    }
    try {
      await this.#listen(window);
    } catch (error) {
      this.#deps.onNote?.(`listen_failed:${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  async #listen(window: Int16Array): Promise<void> {
    const now = this.#clock.now();
    this.#inputLevels.push(rms(window));
    if (this.#inputLevels.length > INPUT_LEVELS_KEPT) {
      this.#inputLevels.shift();
    }
    let probability = await this.#deps.vad.probability(window);
    const guarded = this.#timeline.inGuard(now);
    if (guarded && this.#timeline.followsPlayback(this.#inputLevels)) {
      // The microphone is only carrying the assistant's own voice back.
      probability = 0;
    }
    this.#detector.setStrictStart(this.#timeline.isPlaying() ? BARGE_IN_START : undefined);
    const events = this.#detector.push({ probability, window, endedAtMs: now });
    for (const event of events) {
      this.#onDetected(event);
    }
  }

  #onDetected(event: DetectorEvent): void {
    if (event.type === 'speech_started') {
      this.#guardAtSpeechStart = this.#timeline.inGuard(event.startedAtMs);
      const floorHeld = this.#floorHeld || this.#clock.now() < this.#floorUntilMs;
      this.#overHeldLineAtSpeechStart =
        floorHeld && (this.#timeline.isPlaying() || event.startedAtMs < this.#timeline.endsAtMs);
      if (this.#timeline.isPlaying() && !floorHeld) {
        this.#bargeIn();
      }
      return;
    }
    if (event.type !== 'utterance') {
      return;
    }
    const heard: Heard = {
      samples: event.samples,
      startedAtMs: event.startedAtMs,
      speechEndedAtMs: event.speechEndedAtMs,
      startedInGuard: this.#guardAtSpeechStart,
      startedOverHeldLine: this.#overHeldLineAtSpeechStart,
    };
    // A new utterance replaces a turn that is still being worked on.
    this.#abortTurn();
    this.#turnChain = this.#turnChain.then(() => this.#handle(heard));
  }

  /** Stops speaking at once and lets what the person says next become the next turn. */
  #bargeIn(): void {
    this.#deps.onNote?.('barge_in');
    this.#abortTurn();
    this.#timeline.stop();
    this.#deps.transport.clearAudio();
    this.#setState('listening');
  }

  #abortTurn(): void {
    if (this.#turnAbort === undefined) {
      return;
    }
    this.#turnAbort.abort();
    this.#turnAbort = undefined;
    this.#cancelling = this.#deps.turns.cancel().catch(() => undefined);
  }

  async #handle(heard: Heard): Promise<void> {
    if (this.#ended) {
      return;
    }
    const abort = new AbortController();
    this.#turnAbort = abort;
    const marks: Marks = { speechEndedAtMs: heard.speechEndedAtMs, utteranceAtMs: this.#clock.now() };
    this.#busy = true;
    this.#setState('thinking');
    try {
      const text = await this.#transcribe({ heard, signal: abort.signal });
      if (text === undefined || abort.signal.aborted) {
        return;
      }
      marks.transcribedAtMs = this.#clock.now();
      if (heard.startedInGuard && this.#spoken.repeats(text)) {
        this.#deps.onNote?.('echo_ignored');
        return;
      }
      const awaiting = this.#awaiting;
      if (awaiting !== undefined) {
        await this.#answerWaitingCard({ text, heard, awaiting, signal: abort.signal, marks });
      } else {
        this.#deps.transport.sendEvent({ type: 'heard', text });
        await this.#runTurn({ text, startedOverHeldLine: heard.startedOverHeldLine, signal: abort.signal, marks });
      }
    } finally {
      if (this.#turnAbort === abort) {
        this.#turnAbort = undefined;
      }
      this.#busy = false;
      this.#refreshState();
    }
  }

  async #transcribe({ heard, signal }: { heard: Heard; signal: AbortSignal }): Promise<string | undefined> {
    try {
      const text = (await this.#deps.stt.transcribe({ samples: heard.samples, signal })).trim();
      return text === '' ? undefined : text;
    } catch (error) {
      if (!signal.aborted) {
        this.#deps.onNote?.(`stt_failed:${error instanceof Error ? error.name : 'unknown'}`);
        this.#deps.transport.sendEvent({
          type: 'notice',
          text: 'I could not hear that. Check that speech to text is running, then try again.',
        });
      }
      return undefined;
    }
  }

  async #runTurn({
    text,
    startedOverHeldLine,
    signal,
    marks,
  }: {
    text: string;
    startedOverHeldLine: boolean;
    signal: AbortSignal;
    marks: Marks;
  }): Promise<void> {
    await this.#cancelling;
    const speech = this.#speechFor({ signal, marks });
    const splitter = new SentenceSplitter();
    let spokenChars = 0;
    const say = (sentence: string): void => {
      marks.firstSentenceAtMs ??= this.#clock.now();
      if (spokenChars >= MAX_SPOKEN_CHARS) {
        return;
      }
      spokenChars += sentence.length;
      speech.say({ text: sentence, role: 'body' });
      if (spokenChars >= MAX_SPOKEN_CHARS) {
        speech.say({ text: 'The rest is in the chat.', role: 'instruction' });
      }
    };
    const outcome = await this.#deps.turns.sendMessage({
      text,
      startedOverHeldLine,
      signal,
      onText: delta => {
        splitter.push(delta).forEach(say);
      },
    });
    splitter.flush().forEach(say);
    this.#afterTurn({ outcome, speech, signal });
    await speech.drain();
  }

  async #answerWaitingCard({
    text,
    heard,
    awaiting,
    signal,
    marks,
  }: {
    text: string;
    heard: Heard;
    awaiting: Awaiting;
    signal: AbortSignal;
    marks: Marks;
  }): Promise<void> {
    const answer = classifyAnswer({ heard: text, verb: awaiting.verb });
    // Heard while the assistant spoke or just after, or only repeating its words: never an answer.
    if (heard.startedInGuard || this.#spoken.repeats(text)) {
      this.#deps.onNote?.('approval_guard_ignored');
      return;
    }
    const speech = this.#speechFor({ signal, marks });
    if (answer === 'other') {
      if (!awaiting.reminded) {
        awaiting.reminded = true;
        speech.say({ text: APPROVAL_LINES.waiting(awaiting.verb), role: 'instruction' });
      }
      await speech.drain();
      return;
    }
    this.#awaiting = undefined;
    this.#deps.transport.sendEvent({ type: 'heard', text });
    const decision = answer === 'confirm' ? 'allow' : 'deny';
    let spokenChars = 0;
    const splitter = new SentenceSplitter();
    const say = (sentence: string): void => {
      spokenChars += sentence.length;
      speech.say({ text: sentence, role: 'body' });
    };
    await this.#cancelling;
    const outcome = await this.#deps.turns.answerApproval({
      approval: awaiting.approval,
      decision,
      signal,
      onText: delta => {
        splitter.push(delta).forEach(say);
      },
    });
    splitter.flush().forEach(say);
    if (outcome.kind === 'done' && spokenChars === 0) {
      speech.say({
        text: decision === 'allow' ? APPROVAL_LINES.done(awaiting.verb) : APPROVAL_LINES.turnedDown,
        role: 'instruction',
      });
    }
    this.#afterTurn({ outcome, speech, signal });
    await speech.drain();
  }

  #afterTurn({ outcome, speech, signal }: { outcome: TurnOutcome; speech: SpeechOutput; signal: AbortSignal }): void {
    if (signal.aborted) {
      return;
    }
    if (outcome.kind === 'refused') {
      speech.say({ text: REFUSAL_LINES[outcome.reason], role: 'instruction' });
      return;
    }
    if (outcome.kind === 'failed') {
      speech.say({ text: APPROVAL_LINES.couldNot, role: 'instruction' });
      return;
    }
    this.#deps.transport.sendEvent({ type: 'turn_saved', turn_id: outcome.turnId });
    if (outcome.approvals.length === 0) {
      return;
    }
    const plan = planVoiceApproval({
      pending: outcome.approvals,
      voiceApprovalsAllowed: this.#deps.transport.voiceApprovals,
    });
    this.#readBack({ plan, approvals: outcome.approvals, speech });
  }

  #readBack({
    plan,
    approvals,
    speech,
  }: {
    plan: VoiceApprovalPlan;
    approvals: PendingApproval[];
    speech: SpeechOutput;
  }): void {
    const only = approvals.length === 1 ? approvals[0] : undefined;
    if (plan.kind === 'typed_only' || only === undefined) {
      speech.say({ text: APPROVAL_LINES.leftForTheApp, role: 'instruction' });
      return;
    }
    for (const segment of plan.segments) {
      for (const sentence of splitSentences(segment.text)) {
        speech.say({ text: sentence, role: segment.role });
      }
    }
    this.#awaiting = { approval: only, verb: plan.verb, reminded: false };
  }

  #speechFor({ signal, marks }: { signal: AbortSignal; marks: Marks }): SpeechOutput {
    return new SpeechOutput({
      tts: this.#deps.tts,
      format: this.#deps.transport.outputFormat,
      transport: this.#deps.transport,
      timeline: this.#timeline,
      spoken: this.#spoken,
      signal,
      onAudio: () => {
        if (marks.firstAudioAtMs === undefined) {
          marks.firstAudioAtMs = this.#clock.now();
          this.#reportLatency(marks);
        }
        this.#refreshState();
      },
      onFailure: error => {
        this.#deps.onNote?.(`tts_failed:${error instanceof Error ? error.name : 'unknown'}`);
        this.#deps.transport.sendEvent({
          type: 'notice',
          text: 'I could not speak that. Check that the voice is running. The reply is in the chat.',
        });
      },
    });
  }

  #reportLatency(marks: Marks): void {
    const { transcribedAtMs, firstSentenceAtMs, firstAudioAtMs } = marks;
    if (transcribedAtMs === undefined || firstAudioAtMs === undefined) {
      return;
    }
    const firstSentence = firstSentenceAtMs ?? transcribedAtMs;
    this.#deps.onLatency?.({
      endpointing_ms: Math.max(0, marks.utteranceAtMs - marks.speechEndedAtMs),
      speech_to_text_ms: transcribedAtMs - marks.utteranceAtMs,
      reply_first_sentence_ms: firstSentence - transcribedAtMs,
      voice_first_audio_ms: firstAudioAtMs - firstSentence,
      total_ms: firstAudioAtMs - marks.speechEndedAtMs,
    });
  }

  /** The state the line shows: speaking while audio is queued, thinking while a turn runs, else listening. */
  #refreshState(): void {
    if (this.#ended) {
      return;
    }
    this.#cancelStateCheck?.();
    this.#cancelStateCheck = undefined;
    if (this.#timeline.isPlaying()) {
      this.#setState('speaking');
      const wait = this.#timeline.endsAtMs - this.#clock.now() + 1;
      this.#cancelStateCheck = this.#clock.after(wait, () => {
        this.#refreshState();
      });
      return;
    }
    this.#setState(this.#busy ? 'thinking' : 'listening');
  }

  #setState(state: VoiceState): void {
    if (state === this.#state) {
      return;
    }
    this.#state = state;
    this.#deps.transport.sendEvent({ type: 'state', state });
  }
}

/** The sentences of a card's text, so the first is spoken before the rest is made. */
function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.push(`${text}\n`), ...splitter.flush()];
}
