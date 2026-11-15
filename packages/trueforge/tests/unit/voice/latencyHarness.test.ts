import type { Clock } from '../../../src/voice/echoGuard';
import { measureTurnLatency } from '../../../src/voice/latencyHarness';
import type { SpeechSynthesizer, SpeechToText, VoiceTurnRunner } from '../../../src/voice/transport';
import { LoudnessVad, delay, hum, quiet, virtualDriver } from '../../fixtures/voice/fakes';

function parts(clock: Clock): { stt: SpeechToText; turns: VoiceTurnRunner; tts: SpeechSynthesizer } {
  const stt: SpeechToText = {
    transcribe: async () => {
      await delay({ clock, ms: 120 });
      return 'what time is it';
    },
  };
  const turns: VoiceTurnRunner = {
    sendMessage: async ({ onText }) => {
      await delay({ clock, ms: 80 });
      onText('It is nine o clock. ');
      return { kind: 'done', turnId: 't1', approvals: [] };
    },
    answerApproval: () => Promise.resolve({ kind: 'failed' }),
    stillWaiting: () => Promise.resolve(true),
    cancel: () => Promise.resolve(),
  };
  const tts: SpeechSynthesizer = {
    stream: async function* () {
      await delay({ clock, ms: 60 });
      yield new Uint8Array(960);
    },
  };
  return { stt, turns, tts };
}

const recording = (): Int16Array => Int16Array.from([...quiet(300), ...hum(900), ...quiet(1300)]);

describe('the latency harness on a virtual clock', () => {
  it('splits end of speech to first audio into exactly where the time went', async () => {
    const driver = virtualDriver();
    const latency = await measureTurnLatency({
      parts: { vad: new LoudnessVad(), ...parts(driver.clock) },
      recording: recording(),
      driver,
    });
    // The closing silence is 600 ms, heard 20 windows (640 ms) after speech ended, as the window is judged on the
    // next tick. The virtual clock moves in 32 ms windows, so the 120, 80 and 60 ms of work are each seen at the
    // next window: 128, 96 and 64.
    expect(latency).toEqual({
      endpointing_ms: 640,
      speech_to_text_ms: 128,
      reply_first_sentence_ms: 96,
      voice_first_audio_ms: 64,
      total_ms: 928,
    });
  });

  it('is not changed by a process stall while the person is still speaking', async () => {
    const steady = virtualDriver();
    const expected = await measureTurnLatency({
      parts: { vad: new LoudnessVad(), ...parts(steady.clock) },
      recording: recording(),
      driver: steady,
    });
    // 20 windows is well inside the 900 ms of speech; the clock jumps 1.5 s, as a busy CI machine does.
    const stalled = virtualDriver({ stall: { afterPauses: 20, ms: 1500 } });
    const latency = await measureTurnLatency({
      parts: { vad: new LoudnessVad(), ...parts(stalled.clock) },
      recording: recording(),
      driver: stalled,
    });
    expect(latency).toEqual(expected);
  });
});
