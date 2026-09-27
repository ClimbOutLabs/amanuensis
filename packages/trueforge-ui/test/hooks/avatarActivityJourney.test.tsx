'use client';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useEffect, useState } from 'react';

import { AmanAvatarMotion, type AmanAvatarMotionSources } from '@/components/AmanAvatarMotion.js';
import {
  AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS,
  AvatarActivityProvider,
  useAvatarActivitySink,
  type AmanAvatarActivity,
} from '@/hooks/useAvatarActivity.js';

/**
 * End-to-end USER journey for the living panda avatar: the exact production loop
 * (AvatarActivityProvider -> onActivity -> host state -> AmanAvatarMotion) driven
 * through the provider sink — the same interface AvatarActivityBridge reports into.
 * Each beat's ground truth (e.g. "send with no tokens yet" -> {isBusy:true,
 * isTextStreaming:false}) is pinned by the static bridge tests in
 * useAvatarActivity.test.tsx; this suite proves the raw-activity timeline AND the
 * clip the panda actually displays stay correct across a realistic session.
 */

const SOURCES: AmanAvatarMotionSources = {
  idle: ['/clips/idle-a.mp4', '/clips/idle-b.mp4'],
  thinking: '/clips/thinking.mp4',
  writing: '/clips/writing.mp4',
  error: '/clips/error.mp4',
  poster: '/clips/poster.jpg',
};

type JourneyControl = {
  sink: ReturnType<typeof useAvatarActivitySink>;
  timeline: Array<{ t: number; activity: AmanAvatarActivity }>;
};

function SinkProbe({ control }: { control: JourneyControl }) {
  const sink = useAvatarActivitySink();
  useEffect(() => {
    control.sink = sink;
  }, [control, sink]);
  return null;
}

function JourneyStage({ control }: { control: JourneyControl }) {
  // The host pattern, per TrueFoundryChatProvider docs: the provider's onActivity
  // feeds host state, which flows back into the rail's `activity` prop. The callback
  // is stable: a new identity would look like a re-subscription to the provider,
  // which immediately re-delivers the current activity.
  const [activity, setActivity] = useState<AmanAvatarActivity>('idle');
  const onActivity = useCallback(
    (next: AmanAvatarActivity) => {
      control.timeline.push({ t: Date.now(), activity: next });
      setActivity(next);
    },
    [control],
  );

  return (
    <AvatarActivityProvider onActivity={onActivity}>
      <SinkProbe control={control} />
      <AmanAvatarMotion activity={activity} sources={SOURCES} />
    </AvatarActivityProvider>
  );
}

function setup(): JourneyControl {
  const control: JourneyControl = { sink: null, timeline: [] };
  render(<JourneyStage control={control} />);
  return control;
}

function avatar(): HTMLElement {
  return screen.getByRole('img', { name: /Amanuensis avatar/ });
}

function displayedActivity(): AmanAvatarActivity {
  const src = avatar().getAttribute('src');
  if (src === SOURCES.thinking) return 'thinking';
  if (src === SOURCES.writing) return 'writing';
  if (src === SOURCES.error) return 'error';
  return 'idle';
}

function rawTimeline(control: JourneyControl): AmanAvatarActivity[] {
  return control.timeline.map(entry => entry.activity);
}

/** The bridge reports this when the user sends and the turn starts with no visible tokens yet. */
function sendBeat(control: JourneyControl): void {
  act(() => {
    control.sink?.reportDerived({ isBusy: true, isTextStreaming: false });
  });
}

/** The bridge reports this while visible response tokens stream into chat. */
function streamingBeat(control: JourneyControl, text: string): void {
  void text;
  act(() => {
    control.sink?.reportDerived({ isBusy: true, isTextStreaming: true });
  });
}

/** The bridge reports this when the turn completes. */
function idleBeat(control: JourneyControl): void {
  act(() => {
    control.sink?.reportDerived({ isBusy: false, isTextStreaming: false });
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('avatar activity journey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function (callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn(), callback };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('paints the poster alone on an idle page: no video element, no clip bytes', () => {
    setup();

    expect(document.querySelectorAll('video')).toHaveLength(0);
    const still = avatar();
    expect(still.tagName).toBe('IMG');
    expect(still).toHaveAttribute('src', SOURCES.poster);
    expect(displayedActivity()).toBe('idle');
  });

  it('fast tokens cut straight to writing: idle -> thinking(beat) -> writing -> idle', () => {
    const control = setup();
    expect(displayedActivity()).toBe('idle');

    sendBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking']);
    // The panda acknowledges the send immediately: the thinking clip's quill-lift opening
    // is the attentive beat — the user sees "heard you" inside 300ms, not 1.2s of dead idle.
    expect(displayedActivity()).toBe('thinking');

    // Visible tokens arrive 500ms later, inside the 1200ms beat window.
    advance(500);
    streamingBeat(control, 'Hel');
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'writing']);
    // The thinking loop never settles in: straight to the writing clip.
    expect(displayedActivity()).toBe('writing');

    streamingBeat(control, 'Hello there');
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'writing']);

    // The turn completes; the panda drops straight back to idle.
    advance(1000);
    idleBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'writing', 'idle']);
    expect(displayedActivity()).toBe('idle');
    expect([...SOURCES.idle]).toContain(avatar().getAttribute('src'));
  });

  it('slow start keeps the attentive beat, then dwells before writing', () => {
    const control = setup();

    sendBeat(control);
    // Immediate attentive beat on send.
    expect(displayedActivity()).toBe('thinking');

    // Nothing streams within the beat window: the thinking loop settles in.
    advance(1200);
    expect(displayedActivity()).toBe('thinking');

    // Tokens start 300ms later, past the beat window: the thinking<->writing dwell absorbs the flip.
    advance(300);
    streamingBeat(control, 'Hel');
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'writing']);
    expect(displayedActivity()).toBe('thinking');

    advance(1499);
    expect(displayedActivity()).toBe('thinking');
    advance(1);
    expect(displayedActivity()).toBe('writing');

    advance(2000);
    idleBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'writing', 'idle']);
    expect(displayedActivity()).toBe('idle');
  });

  it('a tool-only turn stays on thinking, never flashing writing', () => {
    const control = setup();

    // Tool calls stream no visible text: the bridge keeps reporting thinking.
    sendBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking']);
    // Attentive beat shows immediately on send.
    expect(displayedActivity()).toBe('thinking');

    advance(1200);
    expect(displayedActivity()).toBe('thinking');

    // Tool work keeps going; no writing clip appears.
    advance(5000);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking']);
    expect(displayedActivity()).toBe('thinking');

    idleBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'thinking', 'idle']);
    expect(displayedActivity()).toBe('idle');
  });

  it('a surfaced error holds the error pose for four seconds, then eases to idle', () => {
    const control = setup();

    act(() => {
      control.sink?.reportError();
    });
    expect(rawTimeline(control)).toEqual(['idle', 'error']);
    // Errors acknowledge instantly, no debounce.
    expect(displayedActivity()).toBe('error');

    advance(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS - 1);
    expect(displayedActivity()).toBe('error');

    advance(1);
    expect(rawTimeline(control)).toEqual(['idle', 'error', 'idle']);
    expect(displayedActivity()).toBe('idle');
  });

  it('a retry in flight supersedes the error pose immediately', () => {
    const control = setup();

    act(() => {
      control.sink?.reportError();
    });
    expect(displayedActivity()).toBe('error');

    // A second before the auto-clear, the retry starts: the panda is working again.
    advance(1000);
    sendBeat(control);
    expect(rawTimeline(control)).toEqual(['idle', 'error', 'thinking']);
    expect(displayedActivity()).toBe('thinking');

    // The disarmed auto-clear never fires.
    advance(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS * 2);
    expect(rawTimeline(control)).toEqual(['idle', 'error', 'thinking']);
    expect(displayedActivity()).toBe('thinking');

    idleBeat(control);
    expect(displayedActivity()).toBe('idle');
  });

  it('thinking<->writing strobe is absorbed by the dwell', () => {
    const control = setup();

    sendBeat(control);
    advance(1200);
    expect(displayedActivity()).toBe('thinking');

    // Tool-call strobe: the raw signal flip-flops faster than the 1500ms dwell.
    for (const text of ['a', 'b', 'c']) {
      streamingBeat(control, text);
      advance(400);
      sendBeat(control);
      advance(400);
    }
    expect(rawTimeline(control)).toEqual([
      'idle',
      'thinking',
      'writing',
      'thinking',
      'writing',
      'thinking',
      'writing',
      'thinking',
    ]);
    // The display never left thinking: every flip cleared the pending dwell timer.
    expect(displayedActivity()).toBe('thinking');

    // Writing finally persists: the dwell elapses and the clip follows.
    streamingBeat(control, 'steady stream');
    advance(1500);
    expect(displayedActivity()).toBe('writing');

    idleBeat(control);
    expect(displayedActivity()).toBe('idle');
  });

  it('keeps a single video element with the poster across the whole journey', () => {
    const control = setup();

    sendBeat(control);
    advance(1200);
    streamingBeat(control, 'Hello');
    advance(1600);
    act(() => {
      control.sink?.reportError();
    });
    advance(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS);
    idleBeat(control);

    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(avatar()).toHaveAttribute('poster', SOURCES.poster);
    expect(displayedActivity()).toBe('idle');
  });
});
