'use client';

import { Fragment } from 'react';

import {
  buildLongWaitAnnouncement,
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
 * The wait queue, Disneyland-style: a winding station track (where the turn has
 * been and where it is headed) plus the state sprite and a microcopy line that
 * names the actual work. Stations only ever change on real events — see
 * `deriveWaitQueue`.
 *
 * Screen-reader discipline: the `role="status"` line carries the microcopy, the
 * latest ticks, and the long-wait note, so station transitions announce exactly
 * once. The ticking elapsed clock and decorative track stay `aria-hidden`, and
 * React only mutates the live text when it actually changes — timer re-renders
 * are silent.
 */
export function WaitQueueIndicator({
  snapshot,
  elapsedMs,
  quietMs,
  reducedMotion,
  className,
}: WaitQueueIndicatorProps) {
  const longWait = quietMs >= LONG_WAIT_MS;
  const announcement = longWait
    ? buildLongWaitAnnouncement({ activeStation: snapshot.activeStation, microcopy: snapshot.microcopy })
    : undefined;

  return (
    <span className={cn('aui-wait-queue', reducedMotion && 'aui-wait-queue--static', className)}>
      <span className="aui-wait-queue__track" aria-hidden="true">
        {snapshot.stations.map((station, index) => (
          <Fragment key={station.id}>
            {index > 0 && <span className="aui-wait-queue__link" />}
            <span
              className={cn(
                'aui-wait-queue__station',
                `aui-wait-queue__station--${station.state}`,
                station.id === 'writing' && station.state === 'active' && 'aui-wait-queue__station--arriving',
              )}
            >
              <span className="aui-wait-queue__dot" />
              <span className="aui-wait-queue__label">{station.label}</span>
            </span>
          </Fragment>
        ))}
      </span>
      <span role="status" className="aui-wait-queue__line">
        <StateSprite state={spriteStateFor(snapshot.activeStation)} />
        <span className="aui-wait-queue__microcopy">{snapshot.microcopy}</span>
        {snapshot.ticks.length > 0 && <span className="sr-only"> · {snapshot.ticks.join(' · ')}</span>}
        {announcement !== undefined && <span className="sr-only"> {announcement}</span>}
      </span>
      {snapshot.ticks.length > 0 && (
        <span className="aui-wait-queue__ticks" aria-hidden="true">
          {snapshot.ticks.map((tick, index) => (
            <span key={`${tick}-${String(index)}`} className="aui-wait-queue__tick">
              ✓ {tick}
            </span>
          ))}
        </span>
      )}
      {longWait && (
        <span className="aui-wait-queue__longwait" aria-hidden="true">
          {buildLongWaitNote({
            elapsedMs,
            activeStation: snapshot.activeStation,
            microcopy: snapshot.microcopy,
          })}
        </span>
      )}
    </span>
  );
}
