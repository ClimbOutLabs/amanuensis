/**
 * Measures one spoken turn from the end of the person's speech to the first sound, on whatever parts
 * it is given: real ones on a real machine, or stand-ins in a test. The recording is played in real
 * time, because the wait for the speech model to decide the person has finished is part of the answer.
 */
import { pcmBytesOf } from './audio';
import { systemClock } from './echoGuard';
import { VoiceSession, type TurnLatency } from './session';
import type { SpeechSynthesizer, SpeechToText, VoiceTransport, VoiceTurnRunner } from './transport';
import type { SpeechProbability } from './vad/sileroVad';
import { VAD_WINDOW_SAMPLES } from './vad/utteranceDetector';

const WINDOW_MS = 32;

class RecordingTransport implements VoiceTransport {
  readonly outputFormat = 'pcm16';
  readonly inputFormat = 'pcm16_16k';
  readonly voiceApprovals = false;
  sendAudio(): void {
    // The measurement only needs to know that audio was made.
  }
  clearAudio(): void {
    // Nothing is playing.
  }
  sendEvent(): void {
    // No screen to update.
  }
  close(): void {
    // No line to hang up.
  }
}

export interface LatencyTrialParts {
  vad: SpeechProbability;
  stt: SpeechToText;
  tts: SpeechSynthesizer;
  turns: VoiceTurnRunner;
}

/** Plays the recording (16 kHz samples that end in quiet) and resolves with the first turn's timings. */
export async function measureTurnLatency({
  parts,
  recording,
  timeoutMs = 30_000,
}: {
  parts: LatencyTrialParts;
  recording: Int16Array;
  timeoutMs?: number;
}): Promise<TurnLatency> {
  const clock = systemClock;
  let report: (latency: TurnLatency) => void = () => undefined;
  const measured = new Promise<TurnLatency>(resolve => {
    report = resolve;
  });
  const session = new VoiceSession({ ...parts, transport: new RecordingTransport(), clock, onLatency: report });
  session.start();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('No sound came back before the time ran out'));
    }, timeoutMs).unref();
  });
  const play = async (): Promise<void> => {
    const started = clock.now();
    for (
      let offset = 0, step = 1;
      offset + VAD_WINDOW_SAMPLES <= recording.length;
      offset += VAD_WINDOW_SAMPLES, step += 1
    ) {
      session.pushAudio(pcmBytesOf(recording.subarray(offset, offset + VAD_WINDOW_SAMPLES)));
      const wait = started + step * WINDOW_MS - clock.now();
      if (wait > 0) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, wait);
        });
      }
    }
  };
  try {
    await Promise.race([play(), measured, timeout]);
    return await Promise.race([measured, timeout]);
  } finally {
    await session.end();
  }
}
