'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from './lib/cn.js';

/**
 * Reward pieces for the reward ladder. Each renders its end state unless
 * `play` is true, which runs its motion once. Reduced motion is CSS-only:
 * the motion is switched off and the end state is what remains. Every piece
 * is decoration; the state change it marks is announced elsewhere.
 */

/** How long a tear layer lives before `onDone` fires. Matches `aui-tear` in styles.css. */
export const STUB_TEAR_MS = 450;

const FLECK_COUNT = 6;

export type RewardPlayProps = {
  /** True runs the motion once; false or omitted shows the end state. */
  play?: boolean;
  className?: string;
};

/** A hand-drawn gold tick. Stroke is gold-ink; the tick draws in 250 ms. */
export function GoldTick({ play = false, className }: RewardPlayProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      data-play={play ? 'true' : 'false'}
      className={cn('aui-reward-tick', className)}
      fill="none"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path pathLength={1} d="M4.5 12.8 L9.6 17.6 L19.6 6.4" />
    </svg>
  );
}

/** A gold sweep behind a phrase. The sweep runs 350 ms; the end state keeps the gold. */
export function Highlight({ play = false, className, children }: RewardPlayProps & { children: ReactNode }) {
  return (
    <span data-play={play ? 'true' : 'false'} className={cn('aui-reward-highlight', className)}>
      {children}
    </span>
  );
}

export type StubTearProps = {
  /** True renders the tear layer and starts the 450 ms tear. */
  play: boolean;
  /** Called once the tear finishes. The consumer then removes the layer and hides the real stub. */
  onDone?: () => void;
  /** The stub's content, cloned into the layer. */
  children: ReactNode;
  className?: string;
};

/**
 * A clone of the stub that tears off and drops away. Nothing renders unless
 * `play` is true. Under reduced motion the layer is hidden by CSS; the
 * consumer should show the stub as gone at the same point.
 */
export function StubTear({ play, onDone, children, className }: StubTearProps) {
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!play) return;
    const timer = window.setTimeout(() => onDoneRef.current?.(), STUB_TEAR_MS);
    return () => window.clearTimeout(timer);
  }, [play]);

  if (!play) return null;
  return (
    <div aria-hidden="true" className={cn('aui-reward-tear', className)}>
      {children}
    </div>
  );
}

export type AllClearProps = {
  /** True runs the gold sweep, the flecks and the warm line's fade. */
  play: boolean;
  /** The warm line from Aman. It is always present; only its fade plays. */
  children: ReactNode;
  className?: string;
};

/** The day's all-clear: one gold sweep, six flecks, then the warm line. */
export function AllClear({ play, children, className }: AllClearProps) {
  return (
    <div className={cn('aui-reward-all-clear', className)}>
      {play ? (
        <>
          <span aria-hidden="true" className="aui-reward-sweep" />
          {Array.from({ length: FLECK_COUNT }, (_, index) => (
            <span key={index} aria-hidden="true" className="aui-reward-fleck" />
          ))}
        </>
      ) : null}
      <div data-play={play ? 'true' : 'false'} className="aui-reward-line">
        {children}
      </div>
    </div>
  );
}

export type HandNoteProps = {
  /** True fades the note in 800 ms after the frame settles. */
  play?: boolean;
  /** The note text, including its signature line. */
  children: ReactNode;
  className?: string;
};

/** A short handwritten note from Aman, in the display face's italic. Never moves. */
export function HandNote({ play = false, children, className }: HandNoteProps) {
  return (
    <p data-play={play ? 'true' : 'false'} className={cn('aui-reward-note', className)}>
      {children}
    </p>
  );
}
