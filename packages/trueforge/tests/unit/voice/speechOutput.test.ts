import { PlaybackTimeline, SpokenTextLog } from '../../../src/voice/echoGuard';
import { SpeechOutput } from '../../../src/voice/speechOutput';
import type { SpeechSynthesizer } from '../../../src/voice/transport';
import { FakeTransport, ManualClock, pcmBytes } from '../../fixtures/voice/fakes';

describe('SpeechOutput', () => {
  it('remembers a long text from when it stops playing, so its tail is known to the echo guard while it is heard', async () => {
    const clock = new ManualClock();
    const SECONDS = 70;
    const slow: SpeechSynthesizer = {
      async *stream() {
        yield pcmBytes(new Int16Array(24_000 * SECONDS));
      },
    };
    const spoken = new SpokenTextLog(clock);
    const timeline = new PlaybackTimeline({ clock, format: 'pcm16' });
    const output = new SpeechOutput({
      tts: slow,
      format: 'pcm16',
      transport: new FakeTransport({ clock, voiceApprovals: true }),
      timeline,
      spoken,
      signal: new AbortController().signal,
      onAudio: () => undefined,
      onFailure: () => undefined,
    });
    output.say({ text: 'Please wire the money to the account on file today', role: 'body' });
    await output.drain();
    // Made at once, but played for 70 s: 80 s in, the last of it ended 10 s ago.
    clock.advance(80_000);
    expect(spoken.repeats({ heard: 'wire the money to the account', minWords: 3 })).toBe(true);
  });
});
