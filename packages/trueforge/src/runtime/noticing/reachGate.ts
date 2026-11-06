import type { Logger } from 'winston';

import type { IDeliveryStore } from '../../db/deliveryStore';
import type { INoticingStore } from '../../db/noticingStore';
import type { PersonOwner } from '../../db/personOwner';
import { newId } from '../../utils/id';
import { startOfLocalDay } from './quietHours';
import type { ReachHistory } from './reachRules';

/**
 * Longest one holder keeps a person's reach decisions to itself before another may take over. It is well past the
 * longest a delivery's sends can take, so a holder never loses it mid-delivery. A holder that hangs past it only lets
 * the next pass decide. Each delivery is made once per id, so that pass sends it again only when no send of it was
 * written down.
 */
const LEASE_MS = 120_000;
const LEASE_TRIES = 10;
const LEASE_WAIT_MS = 250;

export interface ReachGateDeps {
  store: Pick<INoticingStore, 'acquireReachLease' | 'releaseReachLease'>;
  history: Pick<IDeliveryStore, 'countSince' | 'lastCreatedAt'>;
  logger: Logger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs `work` while no other pass is deciding how loudly to reach the same person, so two passes never both read
 * "no nudges yet" and both nudge. Resolves to `held: false` when the person stayed busy for every try.
 */
export async function withReachLease<T>({
  deps,
  owner,
  work,
}: {
  deps: ReachGateDeps;
  owner: PersonOwner;
  work: () => Promise<T>;
}): Promise<{ held: true; value: T } | { held: false }> {
  const holder = newId();
  for (let attempt = 0; attempt < LEASE_TRIES; attempt += 1) {
    const at = deps.now();
    if (await deps.store.acquireReachLease({ ...owner, holder, now: at, until: new Date(at.getTime() + LEASE_MS) })) {
      try {
        return { held: true, value: await work() };
      } finally {
        // What was delivered stays delivered; an unreleased lease only runs out on its own.
        await deps.store.releaseReachLease({ ...owner, holder }).catch((error: unknown) => {
          deps.logger.warn('Could not hand back the reach lease; it runs out by itself', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    await deps.sleep(LEASE_WAIT_MS);
  }
  return { held: false };
}

/**
 * How much has reached the person, read from the feed itself. Only what the assistant noticed counts toward the
 * daily nudges, never a reminder the person set. Any delivery that went out as a call counts toward the gap.
 */
export async function readReachHistory({
  history,
  owner,
  timezone,
  now,
}: {
  history: ReachGateDeps['history'];
  owner: PersonOwner;
  timezone: string;
  now: Date;
}): Promise<ReachHistory> {
  return {
    nudges_today: await history.countSince({
      ...owner,
      since: startOfLocalDay({ now, timezone }),
      kinds: ['nudge', 'approval_waiting'],
      levels: ['nudge'],
    }),
    last_call_at: await history.lastCreatedAt({ ...owner, levels: ['call'] }),
  };
}
