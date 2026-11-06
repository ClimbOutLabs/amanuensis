/**
 * Speaks sentences in order: each is turned into audio as it is made and handed to the transport
 * straight away, so playback starts after the first sentence and the rest queues up behind it.
 */
import type { OutputFormat } from './audio';
import type { PlaybackTimeline, SpokenTextLog } from './echoGuard';
import type { SpeechSynthesizer, VoiceTransport } from './transport';

export type SentenceRole = 'body' | 'instruction';

export interface SpeechOutputDeps {
  tts: SpeechSynthesizer;
  format: OutputFormat;
  transport: VoiceTransport;
  timeline: PlaybackTimeline;
  spoken: SpokenTextLog;
  /** Aborting stops the sentence being made and drops the ones queued. */
  signal: AbortSignal;
  /** Called each time audio is handed to the transport. */
  onAudio: () => void;
  onFailure: (error: unknown) => void;
}

export class SpeechOutput {
  readonly #deps: SpeechOutputDeps;
  #tail: Promise<void> = Promise.resolve();
  /** False once a sentence was lost: it failed, was skipped as empty, or made no sound. */
  #complete = true;

  constructor(deps: SpeechOutputDeps) {
    this.#deps = deps;
  }

  /** With `exact`, the voice must say the text just as written or say nothing of it (see the synthesizer). */
  say({ text, role, exact = false }: { text: string; role: SentenceRole; exact?: boolean }): void {
    this.#tail = this.#tail.then(() => this.#speak({ text, role, exact }));
  }

  /**
   * Resolves when every queued sentence has been made and handed over (not when it has been heard). The
   * value is true only if each of them produced sound, so a caller can tell a card was read in full.
   */
  async drain(): Promise<boolean> {
    await this.#tail;
    return this.#complete;
  }

  async #speak({ text, role, exact }: { text: string; role: SentenceRole; exact: boolean }): Promise<void> {
    const { tts, format, transport, timeline, spoken, signal } = this.#deps;
    const stopped = (): boolean => signal.aborted;
    if (stopped()) {
      return;
    }
    let madeSound = false;
    try {
      let counted = false;
      for await (const chunk of tts.stream({ text, format, signal, exact })) {
        if (stopped()) {
          return;
        }
        if (!counted && role === 'body') {
          // Remembered from the first sound, so an echo of it can be told apart.
          spoken.add(text);
          counted = true;
        }
        madeSound = true;
        timeline.schedule(chunk);
        transport.sendAudio(chunk);
        this.#deps.onAudio();
      }
    } catch (error) {
      if (!stopped()) {
        this.#complete = false;
        this.#deps.onFailure(error);
      }
      return;
    }
    if (!madeSound && !stopped()) {
      this.#complete = false;
    }
    if (madeSound && role === 'body' && !stopped()) {
      // A long text is still playing a minute after its first sound, so its tail is remembered from the last.
      spoken.add(text);
    }
  }
}
