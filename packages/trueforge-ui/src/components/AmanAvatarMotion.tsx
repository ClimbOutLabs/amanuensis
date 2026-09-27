'use client';

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';

import type { AmanAvatarActivity } from '../hooks/useAvatarActivity.js';

/** Where the panda's motion clips live. The two idle variants rotate to conceal the loop. */
export type AmanAvatarMotionSources = {
  idle: readonly string[];
  thinking: string;
  writing: string;
  error: string;
  /** The exact neutral frame: poster while a clip loads, and the still when motion is off. */
  poster: string;
};

type AmanAvatarMotionProps = {
  /** Raw activity from the agent runtime. Display policy (debounce, dwell) is applied here. */
  activity: AmanAvatarActivity;
  sources: AmanAvatarMotionSources;
  className?: string;
};

/** Thinking<->writing only flips once the new state persists this long: absorbs tool-call strobe. */
const WORKING_DWELL_MS = 1500;
/** If visible streaming starts this soon after the send beat, skip the thinking flash entirely. */
const THINKING_FLASH_SKIP_MS = 1200;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);
  return reduced;
}

function pickIdleVariant({ count, except }: { count: number; except: number }): number {
  if (count <= 1) return 0;
  let next = Math.floor(Math.random() * count);
  while (next === except) {
    next = Math.floor(Math.random() * count);
  }
  return next;
}

/**
 * A pause racing a play rejects with AbortError: the visibility/viewport watcher already
 * applied the latest intent, so that one is benign. Anything else is a real failure and
 * gets logged — a clip that cannot play at all surfaces through the element's onError.
 */
function handlePlayRejection(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return;
  }
  console.error('[AmanAvatarMotion] video play failed', error);
}

/**
 * The living panda. One `<video>` at a time, hard-cut between clips: every clip opens on
 * the shared neutral pose (and the poster is that exact frame, so the incoming side of
 * the cut is seamless — no crossfade, no ghosting). The outgoing clip is typically
 * mid-motion when a state change lands, so the cut itself is a visible pose snap; the
 * poster covers the swap while the next clip loads, which reads as a blink at rail
 * size. Never reacts to hover or presence: strictly agent-state-driven.
 *
 * An idle page paints the poster alone: the `<video>` element — and its first clip
 * fetch — waits for the first non-idle activity, so idle users download no video bytes.
 */
export function AmanAvatarMotion({ activity, sources, className }: AmanAvatarMotionProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [display, setDisplay] = useState<AmanAvatarActivity>('idle');
  const displayRef = useRef<AmanAvatarActivity>('idle');
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inViewRef = useRef(true);
  /** True for 1.2s after a send: the flash-skip window where streaming cuts straight to writing. */
  const beatOpenRef = useRef(false);
  const [idleVariant, setIdleVariant] = useState(() => pickIdleVariant({ count: sources.idle.length, except: -1 }));
  /** The video element mounts on the first non-idle display: no video bytes on an idle page. */
  const [mediaLive, setMediaLive] = useState(false);
  /** A clip that fails to load falls back to the static poster for the rest of the session. */
  const [videoFailed, setVideoFailed] = useState(false);
  /** The clip the element actually loaded: rotations and transitions only rebuild the
   *  media pipeline when the clip really changes. */
  const loadedSrcRef = useRef<string | undefined>(undefined);

  const clearTimers = useCallback((): void => {
    for (const timer of timersRef.current) {
      clearTimeout(timer);
    }
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const commit = useCallback((next: AmanAvatarActivity): void => {
    displayRef.current = next;
    setDisplay(next);
  }, []);

  // Raw activity -> displayed activity. The send beat is immediate: the idle->thinking
  // transition commits at once, so the user sees "heard you" within 300ms of sending.
  // The thinking clip opens on the neutral pose with a quill lift — that opening IS the
  // attentive beat; it settles into the thinking loop if work continues. The 1.2s beat
  // window after the send is the flash-skip: streaming that starts inside it cuts straight
  // to writing (a one-way narrative transition, not flip-flop strobe). Past the window,
  // thinking<->writing flip-flop is absorbed by the 1.5s dwell.
  useEffect(() => {
    const beatWasOpen = beatOpenRef.current;
    // A pending transition is stale the moment the raw signal moves again — including back to
    // the currently displayed state, which cancels the flip it interrupted.
    clearTimers();
    beatOpenRef.current = false;
    const current = displayRef.current;
    if (activity === current) return;
    if (activity === 'error' || current === 'error' || activity === 'idle') {
      // Errors acknowledge instantly; the provider auto-clears the raw error after 4s, so the
      // return leg is immediate too. A finished turn drops straight back to idle.
      commit(activity);
      return;
    }
    if (activity === 'thinking' && current === 'idle') {
      // Attentive beat: visible acknowledgment of the send, inside 300ms.
      commit('thinking');
      beatOpenRef.current = true;
      timersRef.current.push(
        setTimeout(() => {
          beatOpenRef.current = false;
        }, THINKING_FLASH_SKIP_MS),
      );
      return;
    }
    if (activity === 'writing' && current === 'idle') {
      // Raw jumped straight to writing with no thinking beat: go straight to writing.
      commit('writing');
      return;
    }
    if (activity === 'writing' && current === 'thinking' && beatWasOpen) {
      // Streaming started inside the beat window: skip the thinking loop, go straight to writing.
      commit('writing');
      return;
    }
    // thinking <-> writing flip-flop during tool-heavy turns: only move once the new state persists.
    timersRef.current.push(setTimeout(() => commit(activity), WORKING_DWELL_MS));
  }, [activity, clearTimers, commit]);

  // Latch off the *displayed* state, not the raw activity: the policy above commits the
  // first non-idle display synchronously with the first non-idle activity, so the video
  // mounts exactly once, already pointed at the right clip — no wasted idle fetch.
  useEffect(() => {
    if (display !== 'idle') {
      setMediaLive(true);
    }
  }, [display]);

  const src = display === 'idle' ? sources.idle[idleVariant] : sources[display];
  // Reduced-motion and screen-reader users get no motion; the name still reports the state.
  const accessibleName = `Amanuensis avatar, ${display}`;

  const handleVideoError = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>): void => {
      const failedSrc = event.currentTarget.currentSrc || src;
      console.error(`[AmanAvatarMotion] clip failed to load (${failedSrc}); falling back to the poster`);
      setVideoFailed(true);
    },
    [src],
  );

  // Pause when the tab hides or the rail scrolls out of view; a hidden video decoding
  // frames is pure waste. One observer + one listener per video instantiation — never
  // rebuilt on clip swaps.
  useEffect(() => {
    if (!mediaLive || reducedMotion) return;
    const video = videoRef.current;
    if (video === null) return;
    const updatePlayback = (): void => {
      if (inViewRef.current && document.visibilityState === 'visible') {
        video.play().catch(handlePlayRejection);
      } else {
        video.pause();
      }
    };
    const observer = new IntersectionObserver(
      entries => {
        inViewRef.current = entries[0]?.isIntersecting ?? true;
        updatePlayback();
      },
      { threshold: 0.1 },
    );
    observer.observe(video);
    document.addEventListener('visibilitychange', updatePlayback);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updatePlayback);
    };
  }, [mediaLive, reducedMotion]);

  // Swap the clip on display change. The poster (neutral frame) covers the load and the
  // incoming clip's first frame is that same pose, so the new motion starts seamlessly.
  // The outgoing clip freezes mid-motion, so the swap itself is a pose snap softened by
  // the poster beat — at rail-avatar size this reads as a blink, not a glitch.
  useEffect(() => {
    if (!mediaLive || reducedMotion) return;
    const video = videoRef.current;
    if (video === null) return;
    if (loadedSrcRef.current !== src) {
      loadedSrcRef.current = src;
      video.load();
    }
    if (inViewRef.current && document.visibilityState === 'visible') {
      video.play().catch(handlePlayRejection);
    }
  }, [src, mediaLive, reducedMotion]);

  // Rotate the idle variants at each loop restart so the loop can't be detected.
  const handleEnded = (): void => {
    if (displayRef.current !== 'idle') return;
    setIdleVariant(previous => pickIdleVariant({ count: sources.idle.length, except: previous }));
  };

  // `muted` as a JSX attribute does not reliably set the underlying property, which is
  // what autoplay policy checks; set it imperatively on mount.
  const attachVideo = useCallback((element: HTMLVideoElement | null): void => {
    videoRef.current = element;
    if (element !== null) {
      element.muted = true;
    }
  }, []);

  if (reducedMotion || !mediaLive || videoFailed) {
    // Static poster: before the first non-idle activity (no video bytes on an idle page),
    // when the user prefers reduced motion, or when a clip failed to load.
    return <img src={sources.poster} alt={accessibleName} className={className} />;
  }

  return (
    <video
      ref={attachVideo}
      className={className}
      role="img"
      aria-label={accessibleName}
      muted
      playsInline
      disablePictureInPicture
      // Idle rotates its two variants at each loop restart (see onEnded); the working and
      // error states are transient, so their clips loop natively on the neutral pose.
      loop={display !== 'idle'}
      // The element mounts with its first clip already set and load() is called
      // imperatively above: never prefetch anything on its own.
      preload="none"
      poster={sources.poster}
      src={src}
      onEnded={handleEnded}
      onError={handleVideoError}
    />
  );
}
