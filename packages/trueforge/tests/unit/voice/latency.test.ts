import { measureTurnLatency } from '../../../src/voice/latencyHarness';
import type { SpeechSynthesizer, SpeechToText, VoiceTurnRunner } from '../../../src/voice/transport';
import { LoudnessVad, hum, quiet } from '../../fixtures/voice/fakes';

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

describe('the latency harness', () => {
  it('measures end of speech to first audio, split into where the time went', async () => {
    const stt: SpeechToText = {
      transcribe: async () => {
        await pause(120);
        return 'what time is it';
      },
    };
    const turns: VoiceTurnRunner = {
      sendMessage: async ({ onText }) => {
        await pause(80);
        onText('It is nine o clock. ');
        return { kind: 'done', turnId: 't1', approvals: [] };
      },
      answerApproval: () => Promise.resolve({ kind: 'failed' }),
      cancel: () => Promise.resolve(),
    };
    const tts: SpeechSynthesizer = {
      stream: async function* () {
        await pause(60);
        yield new Uint8Array(960);
      },
    };
    const recording = Int16Array.from([...quiet(300), ...hum(900), ...quiet(1300)]);
    const latency = await measureTurnLatency({ parts: { vad: new LoudnessVad(), stt, tts, turns }, recording });
    // The closing silence is 600 ms, then 120 + 80 + 60 ms of work, give or take a listening window.
    expect(latency.endpointing_ms).toBeGreaterThanOrEqual(560);
    expect(latency.endpointing_ms).toBeLessThan(760);
    expect(latency.speech_to_text_ms).toBeGreaterThanOrEqual(110);
    expect(latency.reply_first_sentence_ms).toBeGreaterThanOrEqual(70);
    expect(latency.voice_first_audio_ms).toBeGreaterThanOrEqual(50);
    expect(latency.total_ms).toBe(
      latency.endpointing_ms +
        latency.speech_to_text_ms +
        latency.reply_first_sentence_ms +
        latency.voice_first_audio_ms,
    );
    expect(latency.total_ms).toBeLessThan(1500);
  }, 15_000);
});
