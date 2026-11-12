import { PlaybackTimeline, SpokenTextLog } from '../../../src/voice/echoGuard';
import { SpeechOutput } from '../../../src/voice/speechOutput';
import { WouldChangeTextError, type SpeechSynthesizer } from '../../../src/voice/transport';
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

  function outputFor(tts: SpeechSynthesizer) {
    const clock = new ManualClock();
    return new SpeechOutput({
      tts,
      format: 'pcm16',
      transport: new FakeTransport({ clock, voiceApprovals: true }),
      timeline: new PlaybackTimeline({ clock, format: 'pcm16' }),
      spoken: new SpokenTextLog(clock),
      signal: new AbortController().signal,
      onAudio: () => undefined,
      onFailure: () => undefined,
    });
  }

  const sound: SpeechSynthesizer = {
    async *stream() {
      yield pcmBytes(new Int16Array(240));
      await Promise.resolve();
    },
  };
  const refusing: SpeechSynthesizer = {
    async *stream() {
      await Promise.resolve();
      throw new WouldChangeTextError();
    },
  };
  const broken: SpeechSynthesizer = {
    async *stream() {
      await Promise.resolve();
      throw new Error('the voice stopped');
    },
  };
  const silent: SpeechSynthesizer = {
    async *stream() {
      await Promise.resolve();
    },
  };

  it.each([
    ['everything made sound', sound, 'complete'],
    ['the voice would not say a text exactly', refusing, 'refused'],
    ['the voice failed', broken, 'failed'],
    ['a text made no sound', silent, 'failed'],
  ] as const)('ends as expected when %s', async (_name, tts, expected) => {
    const output = outputFor(tts);
    output.say({ text: 'Hello there', role: 'body' });
    expect(await output.drain()).toBe(expected);
  });

  it('keeps a lost sentence as the worse outcome after a refused one', async () => {
    const output = outputFor({
      async *stream({ text }) {
        await Promise.resolve();
        if (text === 'one') {
          throw new WouldChangeTextError();
        }
        throw new Error('the voice stopped');
      },
    });
    output.say({ text: 'one', role: 'body', exact: true });
    output.say({ text: 'two', role: 'body' });
    expect(await output.drain()).toBe('failed');
  });

  it('keeps a lost sentence as the worse outcome when a later one is refused', async () => {
    const output = outputFor({
      async *stream({ text }) {
        await Promise.resolve();
        if (text === 'one') {
          throw new Error('the voice stopped');
        }
        throw new WouldChangeTextError();
      },
    });
    output.say({ text: 'one', role: 'body' });
    output.say({ text: 'two', role: 'body', exact: true });
    expect(await output.drain()).toBe('failed');
  });
});
