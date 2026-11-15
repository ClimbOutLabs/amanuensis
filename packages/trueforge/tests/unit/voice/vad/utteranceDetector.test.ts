import {
  DEFAULT_UTTERANCE_OPTIONS,
  UtteranceDetector,
  VAD_WINDOW_SAMPLES,
  type DetectorEvent,
} from '../../../../src/voice/vad/utteranceDetector';

const WINDOW_MS = 32;

/** Runs the detector over probabilities given one per window: 1 where a letter is `#`, else 0. */
function detect(pattern: string, detector = new UtteranceDetector()): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  [...pattern].forEach((mark, index) => {
    events.push(
      ...detector.push({
        probability: mark === '#' ? 0.95 : 0.02,
        window: new Int16Array(VAD_WINDOW_SAMPLES).fill(index),
        endedAtMs: (index + 1) * WINDOW_MS,
      }),
    );
  });
  return events;
}

describe('UtteranceDetector', () => {
  it('ends an utterance after the closing silence and keeps the words, not the wait', () => {
    const events = detect(`${'.'.repeat(20)}${'#'.repeat(30)}${'.'.repeat(30)}`);
    expect(events.map(event => event.type)).toEqual(['speech_started', 'utterance']);
    const utterance = events[1];
    if (utterance?.type !== 'utterance') throw new Error('expected an utterance');
    expect(utterance.startedAtMs).toBeCloseTo(20 * WINDOW_MS, -1);
    expect(utterance.speechEndedAtMs).toBe(50 * WINDOW_MS);
    // Speech, plus the short pre-roll and trailing pad: well short of the 30 silent windows.
    expect(utterance.samples.length / VAD_WINDOW_SAMPLES).toBeLessThan(30 + 10 + 10 + 2);
    expect(utterance.samples.length / VAD_WINDOW_SAMPLES).toBeGreaterThanOrEqual(30);
  });

  it('does not split an utterance at a short dip', () => {
    const events = detect(`${'#'.repeat(15)}${'.'.repeat(6)}${'#'.repeat(15)}${'.'.repeat(30)}`);
    expect(events.filter(event => event.type === 'utterance')).toHaveLength(1);
  });

  it('splits two utterances separated by a long pause', () => {
    const events = detect(`${'#'.repeat(15)}${'.'.repeat(30)}${'#'.repeat(15)}${'.'.repeat(30)}`);
    expect(events.filter(event => event.type === 'utterance')).toHaveLength(2);
  });

  it('drops a click that is too short to be words', () => {
    const events = detect(`${'.'.repeat(10)}${'#'.repeat(4)}${'.'.repeat(30)}`);
    expect(events).toEqual([]);
  });

  it('needs a stronger and longer start when asked, so a quiet voice does not start it', () => {
    const detector = new UtteranceDetector();
    detector.setStrictStart({ startThreshold: 0.9, minSpeechMs: 400 });
    const events = detect(`${'#'.repeat(10)}${'.'.repeat(30)}`, detector);
    // 10 windows is 320 ms, under the 400 ms asked for.
    expect(events).toEqual([]);
  });

  it('closes an utterance that never ends', () => {
    const detector = new UtteranceDetector({ ...DEFAULT_UTTERANCE_OPTIONS, maxUtteranceMs: 1000 });
    const events = detect('#'.repeat(60), detector);
    expect(events.some(event => event.type === 'utterance')).toBe(true);
  });
});
