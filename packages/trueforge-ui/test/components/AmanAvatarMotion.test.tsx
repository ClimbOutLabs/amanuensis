'use client';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AmanAvatarMotion,
  avatarAltText,
  clipForActivity,
  type AmanAvatarMotionSources,
} from '@/components/AmanAvatarMotion.js';

const ALT = avatarAltText('Maya');

const SOURCES: AmanAvatarMotionSources = {
  idle: ['/aman-avatar/idle-a.mp4', '/aman-avatar/idle-b.mp4'],
  thinking: '/aman-avatar/thinking.mp4',
  writing: '/aman-avatar/writing.mp4',
  error: '/aman-avatar/error.mp4',
  poster: '/aman-avatar/poster.jpg',
};

const WAITING_SOURCES: AmanAvatarMotionSources = { ...SOURCES, waiting: '/aman-avatar/waiting.mp4' };

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

let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
let observerDisconnect: ReturnType<typeof vi.fn> | null = null;

function avatar(): HTMLElement {
  return screen.getByRole('img', { name: ALT });
}

function videoElement(): HTMLVideoElement {
  const video = document.querySelector('video');
  if (video === null) {
    throw new Error('expected the video element to be mounted');
  }
  return video;
}

describe('AmanAvatarMotion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    observerCallback = null;
    observerDisconnect = null;
    vi.stubGlobal(
      'IntersectionObserver',
      // A plain function, not an arrow: the component constructs it with `new`.
      vi.fn(function (callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observerCallback = callback;
        observerDisconnect = vi.fn();
        return { observe: vi.fn(), disconnect: observerDisconnect, unobserve: vi.fn() };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('paints the poster alone on an idle page: no video element, no clip bytes', () => {
    render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} className="aman-runtime-rail__avatar" />);

    const still = avatar();
    expect(still.tagName).toBe('IMG');
    expect(still).toHaveAttribute('src', SOURCES.poster);
    expect(still).toHaveClass('aman-runtime-rail__avatar');
    // The video element — and its first clip fetch — waits for the first non-idle
    // activity: an idle page downloads no video bytes.
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('instantiates the video on the first non-idle activity, already on the right clip', () => {
    const { rerender } = render(
      <AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} className="aman-runtime-rail__avatar" />,
    );
    expect(document.querySelectorAll('video')).toHaveLength(0);

    rerender(
      <AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} className="aman-runtime-rail__avatar" />,
    );

    const video = avatar();
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', SOURCES.thinking);
    expect(video).toHaveAttribute('poster', SOURCES.poster);
    // React does not render `muted` as an attribute; the component sets the underlying
    // property imperatively, which is what autoplay policy actually reads.
    expect(video instanceof HTMLVideoElement && video.muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveClass('aman-runtime-rail__avatar');
    // The element mounts with its first clip already set and load() is called
    // imperatively: it never prefetches anything on its own.
    expect(video).toHaveAttribute('preload', 'none');
    // No crossfade machinery: a single video element, hard cuts only.
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });

  it('keeps the same accessible name in every state', () => {
    const { rerender } = render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAccessibleName(ALT);

    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAccessibleName(ALT);
  });

  it('acknowledges the send immediately with the thinking clip (attentive beat)', () => {
    const { rerender } = render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);

    // The user sees "heard you" inside 300ms: the thinking clip commits at once, and its
    // quill-lift opening is the attentive beat. No 1.2s of dead idle after the send.
    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', SOURCES.thinking);
  });

  it('skips the thinking loop when streaming starts inside the beat window', () => {
    const { rerender } = render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);

    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    // Attentive beat is showing.
    expect(avatar()).toHaveAttribute('src', SOURCES.thinking);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
    // Streaming inside the 1.2s beat window cuts straight to writing: the thinking loop
    // never settles in.
    expect(avatar()).toHaveAttribute('src', SOURCES.writing);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.writing);
  });

  it('debounces thinking<->writing flip-flop with a dwell', () => {
    const { rerender } = render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);

    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.thinking);

    // A brief streaming burst does not flip the display.
    rerender(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.thinking);

    // …but a strobe that flips back cancels the pending transition.
    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.thinking);

    // A sustained new state commits after the dwell.
    rerender(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.writing);
  });

  it('acknowledges errors immediately and follows the auto-clear without dwell', () => {
    const { rerender } = render(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);

    rerender(<AmanAvatarMotion activity="error" sources={SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', SOURCES.error);

    rerender(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);
    expect([...SOURCES.idle]).toContain(avatar().getAttribute('src'));
  });

  it('drops straight back to idle when a turn ends', () => {
    const { rerender } = render(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(avatar()).toHaveAttribute('src', SOURCES.writing);

    rerender(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);
    expect([...SOURCES.idle]).toContain(avatar().getAttribute('src'));
  });

  it('renders only the static poster when the user prefers reduced motion', () => {
    stubMatchMedia(true);
    render(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);

    const still = avatar();
    expect(still.tagName).toBe('IMG');
    expect(still).toHaveAttribute('src', SOURCES.poster);
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('falls back to the poster when a clip fails, then tries the next state', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
      expect(videoElement()).toBeInTheDocument();

      act(() => {
        fireEvent.error(videoElement());
      });

      const still = avatar();
      expect(still.tagName).toBe('IMG');
      expect(still).toHaveAttribute('src', SOURCES.poster);
      expect(document.querySelectorAll('video')).toHaveLength(0);
      expect(consoleError).toHaveBeenCalled();

      // One bad clip must not freeze the panda for the rest of the session: the next state
      // gets its own attempt at its own clip.
      rerender(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
      expect(avatar()).toHaveAttribute('src', SOURCES.writing);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows the poster, not a broken clip, for a waiting state with no waiting clip', () => {
    const { rerender } = render(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', SOURCES.writing);

    rerender(<AmanAvatarMotion activity="waiting" sources={SOURCES} alt={ALT} />);
    const still = avatar();
    expect(still.tagName).toBe('IMG');
    expect(still).toHaveAttribute('src', SOURCES.poster);
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('plays the waiting clip at once when the waiting state has one', () => {
    const { rerender } = render(<AmanAvatarMotion activity="thinking" sources={WAITING_SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', WAITING_SOURCES.thinking);

    // Waiting on the person is settled, not work: no dwell before it shows.
    rerender(<AmanAvatarMotion activity="waiting" sources={WAITING_SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', WAITING_SOURCES.waiting);
  });

  it('resumes working motion as soon as the person has answered', () => {
    const { rerender } = render(<AmanAvatarMotion activity="waiting" sources={WAITING_SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', WAITING_SOURCES.waiting);

    rerender(<AmanAvatarMotion activity="thinking" sources={WAITING_SOURCES} alt={ALT} />);
    expect(avatar()).toHaveAttribute('src', WAITING_SOURCES.thinking);
  });

  describe('clipForActivity', () => {
    it.each([
      ['thinking', SOURCES.thinking],
      ['writing', SOURCES.writing],
      ['error', SOURCES.error],
    ] as const)('maps %s to its own clip', (activity, clip) => {
      expect(clipForActivity({ activity, idleVariant: 0, sources: SOURCES })).toBe(clip);
    });

    it('maps idle to the chosen idle variant', () => {
      expect(clipForActivity({ activity: 'idle', idleVariant: 1, sources: SOURCES })).toBe(SOURCES.idle[1]);
    });

    it('maps waiting to its clip, and to no clip (the poster) when none exists', () => {
      expect(clipForActivity({ activity: 'waiting', idleVariant: 0, sources: WAITING_SOURCES })).toBe(
        WAITING_SOURCES.waiting,
      );
      expect(clipForActivity({ activity: 'waiting', idleVariant: 0, sources: SOURCES })).toBeUndefined();
    });

    it('never maps two different states to the same clip, except the poster stand-in', () => {
      const clips = (['idle', 'thinking', 'writing', 'waiting', 'error'] as const)
        .map(activity => clipForActivity({ activity, idleVariant: 0, sources: WAITING_SOURCES }))
        .filter((clip): clip is string => clip !== undefined);
      expect(new Set(clips).size).toBe(clips.length);
    });
  });

  it('pauses when the tab hides and resumes when it returns', () => {
    render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    const video = avatar();
    const pause = vi.mocked(window.HTMLMediaElement.prototype.pause);
    const play = vi.mocked(window.HTMLMediaElement.prototype.play);
    pause.mockClear();
    play.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pause).toHaveBeenCalledWith();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(play).toHaveBeenCalled();
    expect(video).toBeInTheDocument();
  });

  it('pauses when the rail scrolls out of view', () => {
    render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    const pause = vi.mocked(window.HTMLMediaElement.prototype.pause);
    const play = vi.mocked(window.HTMLMediaElement.prototype.play);
    pause.mockClear();
    play.mockClear();

    expect(observerCallback).not.toBeNull();
    act(() => {
      observerCallback?.([{ isIntersecting: false }]);
    });
    expect(pause).toHaveBeenCalledWith();

    act(() => {
      observerCallback?.([{ isIntersecting: true }]);
    });
    expect(play).toHaveBeenCalled();
  });

  it('rotates the idle variants at each loop restart', () => {
    const { rerender } = render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    rerender(<AmanAvatarMotion activity="idle" sources={SOURCES} alt={ALT} />);
    const first = avatar().getAttribute('src');
    expect([...SOURCES.idle]).toContain(first);

    act(() => {
      fireEvent.ended(avatar());
    });

    const second = avatar().getAttribute('src');
    expect([...SOURCES.idle]).toContain(second);
    expect(second).not.toBe(first);
  });

  it('does not rebuild the media pipeline when the clip has not changed', () => {
    const load = vi.mocked(window.HTMLMediaElement.prototype.load);
    const { rerender } = render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    const initialCalls = load.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    // Re-render with the same activity: the clip is identical, so no new load().
    rerender(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    expect(load.mock.calls.length).toBe(initialCalls);
  });

  it('clears pending transition timers and disconnects the observer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { rerender, unmount } = render(<AmanAvatarMotion activity="thinking" sources={SOURCES} alt={ALT} />);
    // Past the beat window, a writing flip arms the 1.5s dwell timer.
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    rerender(<AmanAvatarMotion activity="writing" sources={SOURCES} alt={ALT} />);

    unmount();

    expect(observerDisconnect).toHaveBeenCalledTimes(1);
    // The armed dwell timer was cleared instead of firing after unmount.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });
});
