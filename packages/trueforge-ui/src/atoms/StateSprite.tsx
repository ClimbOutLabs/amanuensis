'use client';

import doingSprite from '../assets/turn-status/doing.webp';
import foundMemoriesSprite from '../assets/turn-status/found-memories.webp';
import listeningSprite from '../assets/turn-status/listening.webp';
import rememberingSprite from '../assets/turn-status/remembering.webp';
import stillWritingSprite from '../assets/turn-status/still-writing.webp';
import writingSprite from '../assets/turn-status/writing.webp';
import type { TurnSpriteId } from '../utils/waitQueueJourney.js';
import { cn } from './lib/cn.js';

const SPRITE_IMAGES: Record<TurnSpriteId, string> = {
  listening: listeningSprite,
  remembering: rememberingSprite,
  'found-memories': foundMemoriesSprite,
  doing: doingSprite,
  writing: writingSprite,
  'still-writing': stillWritingSprite,
};

export type StateSpriteProps = {
  /** The turn-status sprite to show. */
  state: TurnSpriteId;
  className?: string;
};

/**
 * The turn-status panda: one inlined image per state, selected by the pure
 * `spriteStateFor` mapping. All six states share a 2rem box so the row never
 * shifts between them.
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
      <img src={SPRITE_IMAGES[state]} alt="" draggable={false} />
    </span>
  );
}
