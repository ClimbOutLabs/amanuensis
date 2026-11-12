/**
 * Measures one spoken turn from the end of the person's speech to the first sound, on whatever parts
 * it is given: real ones on a real machine, or stand-ins in a test. The recording is played in real
 * time by default, because the wait for the speech model to decide the person has finished is part of
 * the answer; a test passes a driver with a virtual clock so its split does not depend on the machine.
 */
import { pcmBytesOf } from './audio';
import { systemClock, type Clock } from './echoGuard';
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

/**
 * What drives time in a trial: the clock the engine reads and a way to let some of it pass. Real time sleeps;
 * a test's driver moves a virtual clock instead, so the split depends on the audio and not on the machine.
 */
export interface LatencyDriver {
  clock: Clock;
  pause(ms: number): Promise<void>;
}

export const realTimeDriver: LatencyDriver = {
  clock: systemClock,
  pause: ms =>
    new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    }),
};

/** Plays the recording (16 kHz samples that end in quiet) and resolves with the first turn's timings. */
export async function measureTurnLatency({
  parts,
  recording,
  timeoutMs = 30_000,
  driver = realTimeDriver,
}: {
  parts: LatencyTrialParts;
  recording: Int16Array;
  timeoutMs?: number;
  driver?: LatencyDriver;
}): Promise<TurnLatency> {
  const { clock } = driver;
  let latency: TurnLatency | undefined;
  const session = new VoiceSession({
    ...parts,
    transport: new RecordingTransport(),
    clock,
    onLatency: measured => {
      latency = measured;
    },
  });
  session.start();
  const startedAt = clock.now();
  try {
    // Each window follows the one before by a window's length. After a stall the rest of the recording is still
    // played in real time, never rushed to catch up, since a rushed silence would look like an instant endpoint.
    let due = startedAt;
    for (let offset = 0; offset + VAD_WINDOW_SAMPLES <= recording.length; offset += VAD_WINDOW_SAMPLES) {
      session.pushAudio(pcmBytesOf(recording.subarray(offset, offset + VAD_WINDOW_SAMPLES)));
      due = Math.max(due, clock.now()) + WINDOW_MS;
      const wait = due - clock.now();
      if (wait > 0) {
        await driver.pause(wait);
      }
    }
    while (latency === undefined) {
      if (clock.now() - startedAt > timeoutMs) {
        throw new Error('No sound came back before the time ran out');
      }
      await driver.pause(WINDOW_MS);
    }
    return latency;
  } finally {
    await session.end();
  }
}
