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
import { INPUT_SAMPLE_RATE, InputDecoder, rms } from './audio';
import { ENVELOPE_FRAME_MS, PlaybackTimeline, SpokenTextLog, systemClock, wordsOf, type Clock } from './echoGuard';
import { SentenceSplitter } from './sentences';
import { SpeechOutput } from './speechOutput';
import {
  UncheckedSpeechError,
  WouldChangeTextError,
  type PendingApproval,
  type SpeechSynthesizer,
  type SpeechToText,
  type TurnOutcome,
  type TurnRefusal,
  type VoiceState,
  type VoiceTransport,
  type VoiceTurnRunner,
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
/** Audio waiting to be listened to beyond this many windows (about 5 s, more than any one frame) means listening cannot keep up. */
const MAX_BACKLOG_WINDOWS = 160;
/** Audio may run this far ahead of the clock (a stalled network delivers late pieces in a burst), never more, and the allowance cannot be saved up. */
const REALTIME_SLACK_MS = 5_000;
/** Utterances being turned into words at once; a microphone cannot make more than a couple in the time one takes. */
const MAX_PARALLEL_TRANSCRIPTIONS = 2;
/** Said when a third utterance arrives while two are still being turned into words. */
const MISSED_THAT_NOTICE = 'I missed that. Please say it again.';
const VOICE_OUT_OF_DATE_NOTICE = 'The voice service is out of date. Run aman upgrade, then try again.';
const CARD_ON_SCREEN_NOTICE = 'I stopped reading that card. It is waiting on the screen. Answer it there.';
/** A conversation with no speech from the person for this long ends, so an open mic cannot run on unseen. */
export const IDLE_END_MS = 2 * 60_000;
/** No conversation runs longer than this, whatever is said. */
export const MAX_CONVERSATION_MS = 30 * 60_000;
/** A waiting card is no longer asked after this long; the card itself is still on the screen. */
const AWAITING_MS = 5 * 60_000;
/** Fewer words than this are said by anyone, so they are never dropped as a repeat of the assistant. */
const MIN_ECHO_WORDS = 3;
/** Sounds a person makes while listening: they never cut off the assistant or start a turn. */
const FILLER_WORDS = new Set(['mm', 'hmm', 'mhm', 'uh', 'um', 'uhh', 'umm', 'ah', 'oh', 'huh', 'er', 'erm']);

const REFUSAL_LINES: Record<TurnRefusal, string> = {
  changed: APPROVAL_LINES.changed,
  expired: APPROVAL_LINES.expired,
  not_allowed: APPROVAL_LINES.notAllowed,
  tool_gone: APPROVAL_LINES.notAllowed,
  sign_in: APPROVAL_LINES.signIn,
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
  /** Called when the person starts to speak, before any words are known. */
  onSpeechStarted?: () => void;
}

/** A card whose read-back was made and which is to be waited on. */
interface CardAsked {
  approval: PendingApproval;
  turnId: string;
  verb: ApprovalVerb;
  reminded: boolean;
  expiresAtMs: number;
  /** Said once the body was made; the card is waited on only if this was made too. */
  instruction: string;
}

interface Awaiting extends CardAsked {
  /** Speech that began before this is no answer to the card: the person had not heard it yet. */
  armedAtMs: number;
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
  readonly #transcribing = new Set<Promise<void>>();
  #inOrder: Promise<void> = Promise.resolve();
  readonly #sttAborts = new Set<AbortController>();
  #backlog = 0;
  #working = 0;
  #turnAbort: AbortController | undefined;
  /** Stops only the speaking of the current reply, so the person can talk over it while the turn still saves. */
  #speechAbort: AbortController | undefined;
  /** Aborted when the conversation ends, so a line spoken outside any turn stops with it. */
  readonly #lifetime = new AbortController();
  /** The "I missed that" line being said, if any: talking over it stops it like any other sound. */
  #missedAbort: AbortController | undefined;
  /**
   * Where the audio of a reply made so far ends on the playback timeline. Talking before that point cuts a reply
   * off; a short notice queued after it is not part of one, so talking over only that leaves a card waiting.
   */
  #replyEndsAtMs = 0;
  /** Sound that may still arrive early: it refills as time passes, but never past the slack. */
  #creditMs = REALTIME_SLACK_MS;
  #lastArrivalAtMs = 0;
  #cancelIdle: (() => void) | undefined;
  #cancelMax: (() => void) | undefined;
  #cancelling: Promise<void> = Promise.resolve();
  #guardAtSpeechStart = false;
  #overHeldLineAtSpeechStart = false;
  /** A line that holds the floor is being handed over, or plays until this time. */
  #floorHeld = false;
  #floorUntilMs = Number.NEGATIVE_INFINITY;
  #lineAbort: AbortController | undefined;
  #awaiting: Awaiting | undefined;
  #state: VoiceState = 'listening';
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
    this.#lastArrivalAtMs = this.#clock.now();
    this.#resetIdle();
    this.#cancelMax = this.#clock.after(MAX_CONVERSATION_MS, () => {
      this.#finishAlone('That was a long conversation, so voice mode has ended. Tap voice mode to start again.');
    });
  }

  /** Ends the conversation with a plain-words reason for the person. */
  async #finish(notice: string): Promise<void> {
    this.#deps.transport.sendEvent({ type: 'notice', text: notice });
    await this.end();
  }

  /** Ends the conversation on its own, from a timer or a check. A failure to end it is noted and ends it again. */
  #finishAlone(notice: string): void {
    this.#finish(notice).catch((error: unknown) => {
      this.#abandon({ error, where: 'finish' });
    });
  }

  /** Something the conversation runs on its own failed: note its kind and end the conversation. */
  #abandon({ error, where }: { error: unknown; where: string }): void {
    this.#deps.onNote?.(`${where}_failed:${error instanceof Error ? error.name : 'unknown'}`);
    if (this.#ended) {
      return;
    }
    this.#finish('Voice mode stopped because something went wrong. Tap voice mode to start again.').catch(
      (second: unknown) => {
        this.#deps.onNote?.(`end_failed:${second instanceof Error ? second.name : 'unknown'}`);
      },
    );
  }

  #resetIdle(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = this.#clock.after(IDLE_END_MS, () => {
      this.#finishAlone('Voice mode ended because it was quiet for a while. Tap voice mode to start again.');
    });
  }

  /** The line sent audio. It is processed in order; this returns at once. */
  pushAudio(bytes: Uint8Array): void {
    if (this.#ended) {
      return;
    }
    const arrivedAtMs = this.#clock.now();
    const incoming = this.#decoder.push(bytes);
    // Quiet time cannot be saved up and spent in a burst: credit refills with the clock, up to the slack.
    this.#creditMs = Math.min(REALTIME_SLACK_MS, this.#creditMs + arrivedAtMs - this.#lastArrivalAtMs);
    this.#lastArrivalAtMs = arrivedAtMs;
    this.#creditMs -= (incoming.length / INPUT_SAMPLE_RATE) * 1000;
    if (this.#creditMs < 0) {
      // A microphone delivers one second of sound per second; more than that is not a microphone.
      this.#deps.onNote?.('faster_than_real_time');
      this.#finishAlone('Voice mode could not keep up with your microphone. Tap voice mode to start again.');
      return;
    }
    const joined = new Int16Array(this.#samples.length + incoming.length);
    joined.set(this.#samples);
    joined.set(incoming, this.#samples.length);
    let offset = 0;
    const windowCount = Math.floor(joined.length / VAD_WINDOW_SAMPLES);
    while (joined.length - offset >= VAD_WINDOW_SAMPLES) {
      const window = joined.slice(offset, offset + VAD_WINDOW_SAMPLES);
      // Windows that arrive together were spoken one after another, the last one just now.
      const windowsAfter = windowCount - 1 - offset / VAD_WINDOW_SAMPLES;
      const windowAtMs = arrivedAtMs - windowsAfter * ENVELOPE_FRAME_MS;
      offset += VAD_WINDOW_SAMPLES;
      if (this.#backlog >= MAX_BACKLOG_WINDOWS) {
        // Audio is arriving faster than it can be listened to, which a microphone never does.
        this.#deps.onNote?.('backlog');
        this.#finishAlone('Voice mode could not keep up with your microphone. Tap voice mode to start again.');
        return;
      }
      this.#backlog += 1;
      this.#audioChain = this.#audioChain
        .then(() => this.#onWindow({ window, arrivedAtMs: windowAtMs }))
        .finally(() => {
          this.#backlog -= 1;
        });
    }
    this.#samples = joined.slice(offset);
  }

  /**
   * Speaks a line that no turn asked for, such as the opening of a phone call, after anything already queued. The
   * person can interrupt it like any reply, unless `interruptible` is false: then it plays to the end, and what the
   * person says over it still becomes a turn, marked as started over that line. With `exact`, the line goes to the
   * voice whole and is said only as written, or not at all. Resolves once it has been handed to the line: false when
   * the voice could not say all of it.
   */
  say(
    text: string,
    { interruptible = true, exact = false }: { interruptible?: boolean; exact?: boolean } = {},
  ): Promise<boolean> {
    const spoken = this.#turnChain.then(async () => {
      if (this.#ended) {
        return false;
      }
      const abort = new AbortController();
      if (interruptible) {
        this.#turnAbort = abort;
        this.#speechAbort = abort;
      } else {
        this.#lineAbort = abort;
        this.#floorHeld = true;
      }
      const now = this.#clock.now();
      const speech = this.#speechFor({ signal: abort.signal, marks: { speechEndedAtMs: now, utteranceAtMs: now } });
      for (const sentence of exact ? [text] : splitSentences(text)) {
        speech.say({ text: sentence, role: 'body', exact });
      }
      const whole = (await speech.drain()) === 'complete';
      if (this.#turnAbort === abort) {
        this.#turnAbort = undefined;
      }
      if (!interruptible) {
        this.#lineAbort = undefined;
        this.#floorHeld = false;
        this.#floorUntilMs = this.#timeline.endsAtMs;
      }
      this.#refreshState();
      // A line the person cut off was said well enough; only a voice that could not say it counts as unsaid.
      return whole || abort.signal.aborted;
    });
    // The caller gets the failure through `spoken`, so the chain itself only has to carry on.
    this.#turnChain = spoken.then(
      () => undefined,
      () => undefined,
    );
    return spoken;
  }

  /** Resolves once the audio pushed so far, and the turn it started, have been dealt with. */
  async settled(): Promise<void> {
    await this.#audioChain;
    await Promise.all([...this.#transcribing]);
    await this.#turnChain;
  }

  /** The person ended the conversation (or the line dropped). */
  async end(): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#lifetime.abort();
    this.#cancelStateCheck?.();
    this.#cancelIdle?.();
    this.#cancelMax?.();
    for (const abort of this.#sttAborts) {
      abort.abort();
    }
    const hadTurn = this.#turnAbort !== undefined;
    this.#turnAbort?.abort();
    this.#lineAbort?.abort();
    this.#timeline.stop();
    this.#deps.transport.clearAudio();
    // Only a turn this conversation started is cancelled; one the person typed in the chat is left alone.
    if (hadTurn) {
      await this.#deps.turns.cancel().catch(() => undefined);
    }
    this.#deps.transport.close();
    await this.#audioChain.catch(() => undefined);
    this.#deps.vad.reset();
    await this.#deps.vad.dispose?.().catch(() => undefined);
  }

  async #onWindow({ window, arrivedAtMs }: { window: Int16Array; arrivedAtMs: number }): Promise<void> {
    if (this.#ended) {
      return;
    }
    try {
      await this.#listen({ window, now: arrivedAtMs });
    } catch (error) {
      this.#deps.onNote?.(`listen_failed:${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  /** `now` is when the audio arrived, not when it was reached, so a backed-up queue cannot slip past the guard. */
  async #listen({ window, now }: { window: Int16Array; now: number }): Promise<void> {
    this.#inputLevels.push(rms(window));
    if (this.#inputLevels.length > INPUT_LEVELS_KEPT) {
      this.#inputLevels.shift();
    }
    let probability = await this.#deps.vad.probability(window);
    if (this.#ended) {
      return;
    }
    const guarded = this.#timeline.inGuard(now);
    if (guarded && this.#timeline.followsPlayback({ recentInputRms: this.#inputLevels, atMs: now })) {
      // The microphone is only carrying the assistant's own voice back.
      probability = 0;
    }
    this.#detector.setStrictStart(this.#timeline.isPlaying(now) ? BARGE_IN_START : undefined);
    const events = this.#detector.push({ probability, window, endedAtMs: now });
    for (const event of events) {
      this.#onDetected(event);
    }
  }

  #onDetected(event: DetectorEvent): void {
    if (event.type === 'speech_started') {
      this.#guardAtSpeechStart = this.#timeline.inGuard(event.startedAtMs);
      this.#overHeldLineAtSpeechStart =
        this.#holdsFloor() && (this.#timeline.isPlaying() || event.startedAtMs < this.#timeline.endsAtMs);
      if (this.#state === 'listening') {
        this.#resetIdle();
      }
      this.#deps.onSpeechStarted?.();
      if (!this.#holdsFloor()) {
        this.#talkedOver(event.startedAtMs);
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
    if (this.#sttAborts.size >= MAX_PARALLEL_TRANSCRIPTIONS) {
      // Never dropped silently: it may have been the answer to a waiting card, and the person may not be
      // looking at the screen. Shown always, and spoken unless something is already being said.
      this.#deps.onNote?.('stt_busy');
      this.#deps.transport.sendEvent({ type: 'notice', text: MISSED_THAT_NOTICE });
      if (!this.#timeline.isPlaying()) {
        this.#missedAbort?.abort();
        this.#missedAbort = new AbortController();
        const marks: Marks = { speechEndedAtMs: event.speechEndedAtMs, utteranceAtMs: this.#clock.now() };
        this.#speechFor({
          signal: AbortSignal.any([this.#lifetime.signal, this.#missedAbort.signal]),
          marks,
          kind: 'missed',
        }).say({
          text: MISSED_THAT_NOTICE,
          role: 'instruction',
        });
      }
      return;
    }
    const marks: Marks = { speechEndedAtMs: heard.speechEndedAtMs, utteranceAtMs: this.#clock.now() };
    this.#working += 1;
    this.#setState('thinking');
    const stt = new AbortController();
    this.#sttAborts.add(stt);
    // Words are taken in the order they were spoken, even when a short utterance comes back before a long one.
    // Only a call that is really transcribing holds a place; one that is done and waiting its turn does not.
    const transcription = this.#transcribe({ heard, signal: stt.signal }).finally(() => {
      this.#sttAborts.delete(stt);
    });
    const work = Promise.all([this.#inOrder, transcription])
      .then(([, text]) => {
        marks.transcribedAtMs = this.#clock.now();
        this.#accept({ heard, text, marks });
      })
      .catch((error: unknown) => {
        this.#deps.onNote?.(`accept_failed:${error instanceof Error ? error.name : 'unknown'}`);
      })
      .finally(() => {
        this.#transcribing.delete(work);
        this.#working -= 1;
        this.#refreshState();
      });
    this.#inOrder = work;
    this.#transcribing.add(work);
  }

  /**
   * Once the words are known: a cough, a filler or the assistant's own words coming back do nothing; real
   * speech replaces the turn that was still being worked on.
   */
  #accept({ heard, text, marks }: { heard: Heard; text: string | undefined; marks: Marks }): void {
    if (text === undefined || this.#ended) {
      return;
    }
    const words = wordsOf(text);
    if (words.length > 0 && words.every(word => FILLER_WORDS.has(word))) {
      this.#deps.onNote?.('filler_ignored');
      return;
    }
    if (heard.startedInGuard && this.#spoken.repeats({ heard: text, minWords: MIN_ECHO_WORDS })) {
      this.#deps.onNote?.('echo_ignored');
      return;
    }
    // A reply that began while the person was already talking must not play on after they finish.
    // A line that holds the floor is never cut, even when the person spoke over it.
    if (this.#timeline.isPlaying(heard.speechEndedAtMs) && !heard.startedOverHeldLine && !this.#holdsFloor()) {
      this.#stopSound();
    }
    this.#abortTurn();
    this.#working += 1;
    this.#turnChain = this.#turnChain
      .then(() => this.#handle({ heard, text, marks }))
      .catch((error: unknown) => {
        this.#abandon({ error, where: 'turn' });
      })
      .finally(() => {
        this.#working -= 1;
        this.#refreshState();
      });
  }

  /**
   * The person began to speak while the assistant was talking: stop the sound, keep the turn. While it is
   * only working nothing is cut, since the sound may be a cough; real words decide later.
   */
  #talkedOver(atMs: number): void {
    if (!this.#timeline.isPlaying(atMs)) {
      return;
    }
    this.#deps.onNote?.('barge_in');
    // A read-back that was cut off was not heard through, so it cannot be answered. A short notice was
    // never part of one, so talking over it leaves a waiting card as it is.
    if (atMs < this.#replyEndsAtMs) {
      this.#awaiting = undefined;
    }
    this.#stopSound();
    // A turn that is still working is not quiet, so the quiet clock must not start.
    this.#refreshState();
  }

  /** A line that holds the floor is being handed over or still playing: it is not cut off. */
  #holdsFloor(): boolean {
    return this.#floorHeld || this.#clock.now() < this.#floorUntilMs;
  }

  #stopSound(): void {
    this.#speechAbort?.abort();
    this.#missedAbort?.abort();
    this.#replyEndsAtMs = 0;
    this.#timeline.stop();
    this.#deps.transport.clearAudio();
  }

  #abortTurn(): void {
    if (this.#turnAbort === undefined) {
      return;
    }
    this.#turnAbort.abort();
    this.#turnAbort = undefined;
    this.#cancelling = this.#deps.turns.cancel().catch(() => undefined);
  }

  async #handle({ heard, text, marks }: { heard: Heard; text: string; marks: Marks }): Promise<void> {
    if (this.#ended) {
      return;
    }
    const abort = new AbortController();
    this.#turnAbort = abort;
    const speechAbort = new AbortController();
    this.#speechAbort = speechAbort;
    const signal = abort.signal;
    const speechSignal = AbortSignal.any([signal, speechAbort.signal]);
    try {
      const awaiting = this.#awaiting;
      if (awaiting !== undefined && awaiting.expiresAtMs <= this.#clock.now()) {
        this.#awaiting = undefined;
      }
      const waiting = await this.#stillWaitingCard();
      if (
        waiting !== undefined &&
        !(await this.#answerWaitingCard({ text, heard, awaiting: waiting, signal, speechSignal, marks }))
      ) {
        return;
      }
      this.#deps.transport.sendEvent({ type: 'heard', text });
      await this.#runTurn({ text, startedOverHeldLine: heard.startedOverHeldLine, signal, speechSignal, marks });
    } finally {
      if (this.#turnAbort === abort) {
        this.#turnAbort = undefined;
      }
    }
  }

  /** The card being waited on, or undefined once it was settled somewhere else, such as on the screen. */
  async #stillWaitingCard(): Promise<Awaiting | undefined> {
    const waiting = this.#awaiting;
    if (waiting === undefined) {
      return undefined;
    }
    if (!(await this.#deps.turns.stillWaiting({ turnId: waiting.turnId, approval: waiting.approval }))) {
      if (this.#awaiting === waiting) {
        this.#awaiting = undefined;
      }
      return undefined;
    }
    return waiting;
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
    speechSignal,
    marks,
  }: {
    text: string;
    startedOverHeldLine: boolean;
    signal: AbortSignal;
    speechSignal: AbortSignal;
    marks: Marks;
  }): Promise<void> {
    await this.#cancelling;
    const speech = this.#speechFor({ signal: speechSignal, marks });
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
    await this.#armAfterTurn({
      asking: this.#afterTurn({ outcome, speech, signal }),
      speech,
      speechSignal,
      marks,
    });
  }

  /** A card is waited on only when its whole read-back was made; otherwise it is left for the screen. */
  async #armAfterTurn({
    asking,
    speech,
    speechSignal,
    marks,
  }: {
    asking: CardAsked | undefined;
    speech: SpeechOutput;
    speechSignal: AbortSignal;
    marks: Marks;
  }): Promise<void> {
    let result = await speech.drain();
    if (asking !== undefined && result === 'complete' && !speechSignal.aborted) {
      // How to answer is said only once the card itself was read, so a refused card never asks for an answer.
      speech.say({ text: asking.instruction, role: 'instruction' });
      result = await speech.drain();
    }
    if (asking !== undefined && result !== 'complete' && !speechSignal.aborted) {
      await this.#leaveCardForTheScreen({ signal: speechSignal, marks, refused: result === 'refused' });
      return;
    }
    this.#startAwaiting({ asking, signal: speechSignal });
  }

  async #leaveCardForTheScreen({
    signal,
    marks,
    refused,
  }: {
    signal: AbortSignal;
    marks: Marks;
    refused: boolean;
  }): Promise<void> {
    const speech = this.#speechFor({ signal, marks });
    // A card the voice would not read exactly says why, so it does not look like a card that can never be read.
    speech.say({
      text: refused ? APPROVAL_LINES.cannotReadExactly : APPROVAL_LINES.leftForTheApp,
      role: 'instruction',
    });
    if (refused) {
      this.#deps.transport.sendEvent({ type: 'notice', text: APPROVAL_LINES.cannotReadExactly });
    }
    if ((await speech.drain()) !== 'complete') {
      this.#deps.transport.sendEvent({
        type: 'notice',
        text: 'I could not read all of that out loud, so it is waiting on the screen. Answer it there.',
      });
    }
  }

  /** The card is waited on only once its read-back was heard through; a person who cut it off sees it on screen. */
  #startAwaiting({ asking, signal }: { asking: CardAsked | undefined; signal: AbortSignal }): void {
    if (asking === undefined) {
      return;
    }
    if (signal.aborted || this.#ended) {
      // Cut off before it could be waited on: the card stays on the screen, and the screen is told so.
      if (!this.#ended) {
        this.#deps.transport.sendEvent({ type: 'notice', text: CARD_ON_SCREEN_NOTICE });
      }
      return;
    }
    this.#awaiting = { ...asking, armedAtMs: this.#clock.now() };
  }

  /** Returns true when the words are not an answer to the card and should run as a turn of their own. */
  async #answerWaitingCard({
    text,
    heard,
    awaiting,
    signal,
    speechSignal,
    marks,
  }: {
    text: string;
    heard: Heard;
    awaiting: Awaiting;
    signal: AbortSignal;
    speechSignal: AbortSignal;
    marks: Marks;
  }): Promise<boolean> {
    // Said before the card was read out, so it cannot be an answer to it: it gets the reminder like any other words.
    const early = heard.startedAtMs < awaiting.armedAtMs;
    if (early) {
      this.#deps.onNote?.('speech_before_card');
    }
    const answer = early ? 'other' : classifyAnswer({ heard: text, verb: awaiting.verb });
    const speech = this.#speechFor({ signal: speechSignal, marks });
    if (answer === 'other') {
      if (awaiting.reminded) {
        // Asked once already: other speech is a new turn, and the card stays on the screen.
        this.#awaiting = undefined;
        return true;
      }
      awaiting.reminded = true;
      speech.say({ text: APPROVAL_LINES.waiting(awaiting.verb), role: 'instruction' });
      await speech.drain();
      return false;
    }
    // The exact phrase is held to the timing guard only: it is the one thing the assistant's own words contain.
    if (heard.startedInGuard) {
      this.#deps.onNote?.('approval_guard_ignored');
      speech.say({ text: APPROVAL_LINES.sayAgain, role: 'instruction' });
      await speech.drain();
      return false;
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
    await this.#armAfterTurn({
      asking: this.#afterTurn({ outcome, speech, signal }),
      speech,
      speechSignal,
      marks,
    });
    return false;
  }

  /** Says what happened and returns the card to wait on, if the turn ended asking for one. */
  #afterTurn({
    outcome,
    speech,
    signal,
  }: {
    outcome: TurnOutcome;
    speech: SpeechOutput;
    signal: AbortSignal;
  }): CardAsked | undefined {
    if (signal.aborted) {
      return undefined;
    }
    if (outcome.kind === 'refused') {
      speech.say({ text: REFUSAL_LINES[outcome.reason], role: 'instruction' });
      return undefined;
    }
    if (outcome.kind === 'failed') {
      speech.say({ text: APPROVAL_LINES.couldNot, role: 'instruction' });
      return undefined;
    }
    this.#deps.transport.sendEvent({ type: 'turn_saved', turn_id: outcome.turnId });
    if (outcome.approvals.length === 0) {
      return undefined;
    }
    const plan = planVoiceApproval({
      pending: outcome.approvals,
      voiceApprovalsAllowed: this.#deps.transport.voiceApprovals,
    });
    return this.#readBack({ plan, approvals: outcome.approvals, speech, turnId: outcome.turnId });
  }

  #readBack({
    plan,
    approvals,
    speech,
    turnId,
  }: {
    plan: VoiceApprovalPlan;
    approvals: PendingApproval[];
    speech: SpeechOutput;
    turnId: string;
  }): CardAsked | undefined {
    const only = approvals.length === 1 ? approvals[0] : undefined;
    if (plan.kind === 'typed_only' || only === undefined) {
      speech.say({ text: APPROVAL_LINES.leftForTheApp, role: 'instruction' });
      return undefined;
    }
    // The card goes to the voice as one text that must be said exactly as written, or the voice says nothing
    // of it: what was judged is what is heard, so nothing is approved that was not heard.
    speech.say({ text: plan.body, role: 'body', exact: true });
    const now = this.#clock.now();
    return {
      approval: only,
      turnId,
      verb: plan.verb,
      reminded: false,
      expiresAtMs: now + AWAITING_MS,
      instruction: plan.instruction,
    };
  }

  #speechFor({
    signal,
    marks,
    kind = 'reply',
  }: {
    signal: AbortSignal;
    marks: Marks;
    kind?: 'reply' | 'missed';
  }): SpeechOutput {
    let reported = false;
    return new SpeechOutput({
      tts: this.#deps.tts,
      format: this.#deps.transport.outputFormat,
      transport: this.#deps.transport,
      timeline: this.#timeline,
      spoken: this.#spoken,
      signal,
      onAudio: () => {
        if (kind === 'reply') {
          this.#replyEndsAtMs = this.#timeline.endsAtMs;
        }
        if (marks.firstAudioAtMs === undefined) {
          marks.firstAudioAtMs = this.#clock.now();
          this.#reportLatency(marks);
        }
        this.#refreshState();
      },
      onFailure: error => {
        if (error instanceof WouldChangeTextError) {
          // The voice is working; it would only not say this text as written. The card stays on the screen.
          this.#deps.onNote?.('read_back_refused');
          return;
        }
        if (error instanceof UncheckedSpeechError) {
          // The voice is running but is not the version that checks words, so "check it is running" is wrong advice.
          this.#deps.onNote?.('tts_unchecked');
          this.#deps.transport.sendEvent({ type: 'notice', text: VOICE_OUT_OF_DATE_NOTICE });
          return;
        }
        this.#deps.onNote?.(`tts_failed:${error instanceof Error ? error.name : 'unknown'}`);
        // Once per reply: a dead voice fails every sentence, and one signal is enough to act on.
        if (!reported) {
          reported = true;
          this.#deps.transport.sendEvent({ type: 'tts_failed' });
        }
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
    this.#setState(this.#working > 0 ? 'thinking' : 'listening');
  }

  #setState(state: VoiceState): void {
    if (state === this.#state) {
      return;
    }
    this.#state = state;
    if (state === 'listening') {
      this.#resetIdle();
    } else {
      // A long turn or a long reply is not quiet: the clock starts again once it is over.
      this.#cancelIdle?.();
      this.#cancelIdle = undefined;
    }
    this.#deps.transport.sendEvent({ type: 'state', state });
  }
}

/** The sentences of a line no turn asked for, so the first is spoken before the rest is made. */
function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.push(text), ...splitter.flush()];
}
