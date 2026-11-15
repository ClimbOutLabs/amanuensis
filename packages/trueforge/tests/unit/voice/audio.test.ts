import { decodeMulaw, InputDecoder, rms, wavFromSamples } from '../../../src/voice/audio';
import { SentenceSplitter } from '../../../src/voice/sentences';
import { VoiceSession } from '../../../src/voice/session';
import { VAD_WINDOW_SAMPLES } from '../../../src/voice/vad/utteranceDetector';
import {
  FakeStt,
  FakeTransport,
  FakeTts,
  FakeTurns,
  hum,
  LoudnessVad,
  ManualClock,
  mulawBytes,
  quiet,
} from '../../fixtures/voice/fakes';

describe('audio helpers', () => {
  it('decodes mu-law back to nearly the same samples', () => {
    const original = Int16Array.from([0, 1000, -1000, 8000, -8000, 20000]);
    const decoded = decodeMulaw(mulawBytes(original));
    original.forEach((sample, index) => {
      expect(Math.abs((decoded[index] ?? 0) - sample)).toBeLessThanOrEqual(Math.max(40, Math.abs(sample) * 0.04));
    });
  });

  it('joins an odd byte to the next piece instead of losing it', () => {
    const decoder = new InputDecoder('pcm16_16k');
    const bytes = Uint8Array.from([1, 0, 2, 0, 3, 0]);
    expect([...decoder.push(bytes.subarray(0, 3)), ...decoder.push(bytes.subarray(3))]).toEqual([1, 2, 3]);
  });

  it('turns 8 kHz phone audio into twice as many 16 kHz samples', () => {
    const decoder = new InputDecoder('mulaw8k');
    expect(decoder.push(mulawBytes(new Int16Array(160))).length).toBe(320);
  });

  it('writes a 16 kHz mono 16-bit WAV header the speech-to-text container accepts', () => {
    const wav = wavFromSamples(new Int16Array(160));
    const text = (from: number, to: number): string => String.fromCharCode(...wav.subarray(from, to));
    expect([text(0, 4), text(8, 12), text(36, 40)]).toEqual(['RIFF', 'WAVE', 'data']);
    const view = new DataView(wav.buffer);
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), wav.length]).toEqual([
      1,
      16000,
      16,
      44 + 320,
    ]);
  });

  it('measures loudness', () => {
    expect(rms(new Int16Array(10))).toBe(0);
    expect(rms(hum(100))).toBeGreaterThan(0.05);
  });
});

describe('SentenceSplitter', () => {
  const split = (...pieces: string[]): string[] => {
    const splitter = new SentenceSplitter();
    return [...pieces.flatMap(piece => splitter.push(piece)), ...splitter.flush()];
  };

  it('gives the first sentence as soon as the next character shows it is over', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('You have two meetings')).toEqual([]);
    expect(splitter.push('. The first')).toEqual(['You have two meetings.']);
    expect(splitter.flush()).toEqual(['The first']);
  });

  it('does not cut at a decimal, an abbreviation or the end of a half sentence', () => {
    expect(split('It costs 3.5 dollars. Ask Dr. Lee today.')).toEqual(['It costs 3.5 dollars.', 'Ask Dr. Lee today.']);
  });

  it('reads list items and headings without their marks, one at a time', () => {
    expect(split('# Plan\n- Buy milk\n- Call Anna\n')).toEqual(['Plan', 'Buy milk', 'Call Anna']);
  });

  it('never reads code aloud', () => {
    expect(split('Run this.\n```\nrm -rf x\n```\nThen wait.')).toEqual(['Run this.', 'Then wait.']);
  });
});

describe('a phone line as the transport', () => {
  it('hears 8 kHz mu-law and answers in 8 kHz mu-law, without the engine knowing which line it is on', async () => {
    const clock = new ManualClock();
    const transport = new FakeTransport({
      clock,
      voiceApprovals: false,
      inputFormat: 'mulaw8k',
      outputFormat: 'mulaw8k',
    });
    const turns = new FakeTurns({ message: [{ text: ['Hello caller.'] }] });
    const session = new VoiceSession({
      transport,
      vad: new LoudnessVad(),
      stt: new FakeStt('hi'),
      tts: new FakeTts(),
      turns,
      clock,
    });
    session.start();
    // 8 kHz frames of 20 ms, as a phone line sends them: a second of voice, then quiet.
    const eightK = (samples: Int16Array): Int16Array => samples.filter((_, index) => index % 2 === 0);
    const call = eightK(Int16Array.from([...hum(900), ...quiet(900)]));
    for (let offset = 0; offset < call.length; offset += 160) {
      session.pushAudio(mulawBytes(call.subarray(offset, offset + 160)));
      clock.advance(20);
      await new Promise(resolve => setImmediate(resolve));
    }
    await session.settled();
    expect(turns.sent).toEqual(['hi']);
    expect(transport.audio.length).toBeGreaterThan(0);
    expect(VAD_WINDOW_SAMPLES).toBe(512);
  });
});
