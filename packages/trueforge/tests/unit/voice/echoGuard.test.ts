import { PlaybackTimeline } from '../../../src/voice/echoGuard';
import { ManualClock, pcmBytes } from '../../fixtures/voice/fakes';

function pulsing(ms: number): Int16Array {
  const out = new Int16Array(Math.round((24_000 * ms) / 1000));
  for (let n = 0; n < out.length; n += 1) {
    const t = n / 24_000;
    out[n] = Math.round(Math.sin(2 * Math.PI * 200 * t) * (0.15 + 0.15 * Math.sin(2 * Math.PI * 5 * t)) * 32767);
  }
  return out;
}

describe('the playback timeline', () => {
  it('judges playing and echo at the time the sound reached the microphone, not when it was looked at', () => {
    const clock = new ManualClock();
    const timeline = new PlaybackTimeline({ clock, format: 'pcm16' });
    const start = clock.now();
    timeline.schedule(pcmBytes(pulsing(1000)));
    clock.advance(5000);
    // Looked at five seconds late, the sound is long over; but a window from 100 ms in was heard during it.
    expect(timeline.isPlaying()).toBe(false);
    expect(timeline.isPlaying(start + 100)).toBe(true);
    expect(timeline.isPlaying(start + 1500)).toBe(false);
  });

  it('compares the microphone with what was playing at the time of the window', () => {
    const clock = new ManualClock();
    const timeline = new PlaybackTimeline({ clock, format: 'pcm16' });
    const start = clock.now();
    timeline.schedule(pcmBytes(pulsing(1000)));
    // The loudness the microphone would carry back: the same shape as what was sent, 10 frames of 32 ms.
    const heard = Array.from({ length: 10 }, (_, frame) => {
      const t = (start % 32) / 1000 + (frame * 32) / 1000 + 0.2;
      return 0.2 * (0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 2.5 * t)));
    });
    const during = start + 200 + 10 * 32;
    clock.advance(4000);
    expect(timeline.followsPlayback({ recentInputRms: heard, atMs: during })).toBe(true);
    expect(timeline.followsPlayback({ recentInputRms: heard, atMs: clock.now() })).toBe(false);
  });
});
