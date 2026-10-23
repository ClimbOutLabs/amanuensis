'use client';

import {
  buildLongWaitNote,
  LONG_WAIT_MS,
  type WaitQueueSnapshot,
  type WaitStationId,
} from '../utils/waitQueueJourney.js';
import { cn } from './lib/cn.js';
import { StateSprite, type StateSpriteState } from './StateSprite.js';

export type WaitQueueIndicatorProps = {
  snapshot: WaitQueueSnapshot;
  elapsedMs: number;
  /** Time since anything new arrived for the turn; the long-wait note shows only after a quiet spell. */
  quietMs: number;
  reducedMotion: boolean;
  className?: string;
};

/**
 * The sprite mirrors the active station. `remembering` is never the active
 * station (it is event-sourced only), so a null station — the model thinking
 * before tools or text — shows the remembering sprite.
 */
function spriteStateFor(activeStation: WaitStationId | null): StateSpriteState {
  if (activeStation === 'doing') return 'doing';
  if (activeStation === 'writing') return 'writing';
  if (activeStation === 'listening') return 'listening';
  return 'remembering';
}

/**
 * A running reply's one status line: the state sprite and plain words for the actual work, from
 * `deriveWaitQueue`. After a quiet spell the same line says how long it has been, so a slow model
 * reads as still working rather than stuck. Finished steps go to screen readers only, so nothing
 * stacks under the line.
 */
export function WaitQueueIndicator({
  snapshot,
  elapsedMs,
  quietMs,
  reducedMotion,
  className,
}: WaitQueueIndicatorProps) {
  const longWait = quietMs >= LONG_WAIT_MS;

  return (
    <span className={cn('aui-wait-queue', reducedMotion && 'aui-wait-queue--static', className)}>
      <span role="status" className="aui-wait-queue__line">
        <StateSprite state={spriteStateFor(snapshot.activeStation)} />
        <span className="aui-wait-queue__microcopy">
          {longWait
            ? buildLongWaitNote({ elapsedMs, activeStation: snapshot.activeStation, microcopy: snapshot.microcopy })
            : snapshot.microcopy}
        </span>
        {snapshot.ticks.length > 0 && <span className="sr-only"> · {snapshot.ticks.join(' · ')}</span>}
      </span>
    </span>
  );
}
