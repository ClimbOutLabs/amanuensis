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

  constructor(deps: SpeechOutputDeps) {
    this.#deps = deps;
  }

  say({ text, role }: { text: string; role: SentenceRole }): void {
    this.#tail = this.#tail.then(() => this.#speak({ text, role }));
  }

  /** Resolves when every queued sentence has been made and handed over (not when it has been heard). */
  drain(): Promise<void> {
    return this.#tail;
  }

  async #speak({ text, role }: { text: string; role: SentenceRole }): Promise<void> {
    const { tts, format, transport, timeline, spoken, signal } = this.#deps;
    if (signal.aborted) {
      return;
    }
    try {
      let counted = false;
      for await (const chunk of tts.stream({ text, format, signal })) {
        if (signal.aborted) {
          return;
        }
        if (!counted && role === 'body') {
          // Remembered from the first sound, so an echo of it can be told apart.
          spoken.add(text);
          counted = true;
        }
        timeline.schedule(chunk);
        transport.sendAudio(chunk);
        this.#deps.onAudio();
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#deps.onFailure(error);
      }
    }
  }
}
