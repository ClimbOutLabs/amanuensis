'use client';

import type { WaitStationId } from '../utils/waitQueueJourney.js';
import { cn } from './lib/cn.js';

export type StateSpriteState = WaitStationId;

export type StateSpriteProps = {
  /** The wait-queue station the sprite mirrors. */
  state: StateSpriteState;
  className?: string;
};

/**
 * A tiny CSS-only character that mirrors the assistant's current wait-queue
 * station: Listening bobs with sound waves, Remembering floats thought
 * bubbles, Doing jiggles with speed lines, Writing scribbles with a pencil.
 *
 * Decorative by design: the station track and the role="status" microcopy
 * line already communicate state to assistive tech, so the sprite stays
 * aria-hidden and never announces.
 */
export function StateSprite({ state, className }: StateSpriteProps) {
  return (
    <span
      data-testid="state-sprite"
      className={cn('aui-state-sprite', `aui-state-sprite--${state}`, className)}
      aria-hidden="true"
    >
      <span className="aui-state-sprite__body" />
      <span className="aui-state-sprite__fx aui-state-sprite__fx--1" />
      <span className="aui-state-sprite__fx aui-state-sprite__fx--2" />
      <span className="aui-state-sprite__fx aui-state-sprite__fx--3" />
    </span>
  );
}
