import { PlaybackTimeline, SpokenTextLog } from '../../../src/voice/echoGuard';
import { SpeechOutput } from '../../../src/voice/speechOutput';
import type { SpeechSynthesizer } from '../../../src/voice/transport';
import { FakeTransport, ManualClock, pcmBytes } from '../../fixtures/voice/fakes';

describe('SpeechOutput', () => {
  it('remembers a long text again when its last sound is made, so its tail is still known to the echo guard', async () => {
    const clock = new ManualClock();
    let finish: () => void = () => undefined;
    const slow: SpeechSynthesizer = {
      async *stream() {
        yield pcmBytes(new Int16Array(240));
        await new Promise<void>(resolve => {
          finish = resolve;
        });
        yield pcmBytes(new Int16Array(240));
      },
    };
    const spoken = new SpokenTextLog(clock);
    const output = new SpeechOutput({
      tts: slow,
      format: 'pcm16',
      transport: new FakeTransport({ clock, voiceApprovals: true }),
      timeline: new PlaybackTimeline({ clock, format: 'pcm16' }),
      spoken,
      signal: new AbortController().signal,
      onAudio: () => undefined,
      onFailure: () => undefined,
    });
    output.say({ text: 'Please wire the money to the account on file today', role: 'body' });
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
    clock.advance(50_000);
    finish();
    await output.drain();
    clock.advance(30_000);
    expect(spoken.repeats({ heard: 'wire the money to the account', minWords: 3 })).toBe(true);
  });
});
