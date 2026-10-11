'use client';

import type { TurnSpriteId } from '../utils/waitQueueJourney.js';
import { cn } from './lib/cn.js';

export type StateSpriteProps = {
  /** The turn-status sprite to show. */
  state: TurnSpriteId;
  className?: string;
};

/**
 * The turn-status panda, drawn in code: one inline SVG whose per-state pose
 * and accents are toggled by the state modifier class. All six states share
 * a 2rem box so the row never shifts between them.
 *
 * Flat shapes, theme-token colors, transparent background. Motion lives in
 * the stylesheet, gated on `prefers-reduced-motion: no-preference` and off
 * under `.aui-wait-queue--static`; without motion the panda holds its static
 * pose.
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
      <svg viewBox="0 0 64 64" role="presentation" focusable="false">
        <g className="panda-head">
          <circle className="panda-dark panda-ear panda-ear-l" cx="18" cy="18" r="8" />
          <circle className="panda-dark panda-ear panda-ear-r" cx="46" cy="18" r="8" />
          <circle className="panda-face" cx="32" cy="34" r="19" />
          <ellipse className="panda-dark" cx="24.5" cy="31.5" rx="4" ry="5" transform="rotate(-8 24.5 31.5)" />
          <ellipse className="panda-dark" cx="39.5" cy="31.5" rx="4" ry="5" transform="rotate(8 39.5 31.5)" />
          <g className="panda-eyes">
            <circle className="panda-face" cx="25" cy="30.5" r="3" />
            <circle className="panda-face" cx="39" cy="30.5" r="3" />
            <g className="panda-pupils">
              <circle className="panda-dark" cx="25" cy="31" r="1.6" />
              <circle className="panda-dark" cx="39" cy="31" r="1.6" />
              <circle className="panda-face" cx="25.6" cy="30.4" r="0.55" />
              <circle className="panda-face" cx="39.6" cy="30.4" r="0.55" />
            </g>
          </g>
          <ellipse className="panda-dark" cx="32" cy="40.5" rx="2" ry="1.5" />
          <path
            className="panda-mouth"
            d="M28.5 44.5 Q32 47 35.5 44.5"
            fill="none"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </g>
        <g className="panda-paws">
          <ellipse className="panda-dark panda-paw panda-paw-l" cx="19" cy="56" rx="5.5" ry="4" />
          <ellipse className="panda-dark panda-paw panda-paw-r" cx="45" cy="56" rx="5.5" ry="4" />
        </g>
        <g className="panda-sparkle" aria-hidden="true">
          <path className="panda-accent" d="M52 6 L53.6 11.4 L59 13 L53.6 14.6 L52 20 L50.4 14.6 L45 13 L50.4 11.4 Z" />
        </g>
        <g className="panda-pencil" aria-hidden="true">
          <g transform="rotate(24 50 52)">
            <rect className="panda-accent" x="48.2" y="42" width="3.6" height="12" rx="1" />
            <path className="panda-face" d="M48.2 54 L50 58.4 L51.8 54 Z" />
            <path className="panda-dark" d="M49.4 56.6 L50 58.4 L50.6 56.6 Z" />
          </g>
        </g>
      </svg>
    </span>
  );
}
