import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore } from '../../db/textContactStore';

export const HOUR_MS = 60 * 60_000;
/** The longest window of any limit, so old counts can be forgotten without ending a window that is still open. */
export const DAY_MS = 24 * HOUR_MS;

/** Texts a day to one person from deliveries of every kind, reminders and tests included, so a loop cannot run up the bill. */
export const MAX_TEXTS_PER_PERSON_PER_DAY = 30;
/** Test texts an hour from the Try it button. */
export const MAX_TEST_TEXTS_PER_HOUR = 3;

/** At most `max` sends for `key` in a window that ends `window_ms` after its first send, at most a day. */
export interface TextLimit {
  key: string;
  window_ms: number;
  max: number;
}

export function ownerLimitKey({ scope, owner }: { scope: string; owner: PersonOwner }): string {
  return `${scope}:${JSON.stringify([owner.tenant_id, owner.created_by])}`;
}

export function deliveryTextLimit(owner: PersonOwner): TextLimit {
  return { key: ownerLimitKey({ scope: 'texts-day', owner }), window_ms: DAY_MS, max: MAX_TEXTS_PER_PERSON_PER_DAY };
}

export function testTextLimit(owner: PersonOwner): TextLimit {
  return { key: ownerLimitKey({ scope: 'test-text', owner }), window_ms: HOUR_MS, max: MAX_TEST_TEXTS_PER_HOUR };
}

/**
 * Counts one send against each limit in turn, each in one statement before anything is sent, so neither parallel
 * requests nor a failing provider get past a limit. A limit already passed when a later one refuses stays spent.
 */
export async function claimTextLimits({
  store,
  limits,
  at,
}: {
  store: Pick<ITextContactStore, 'claimTextSend' | 'forgetTextSends'>;
  limits: readonly TextLimit[];
  at: Date;
}): Promise<{ ok: true } | { ok: false; retry_in_minutes: number }> {
  await store.forgetTextSends({ before: new Date(at.getTime() - DAY_MS) });
  for (const limit of limits) {
    const claim = await store.claimTextSend({ ...limit, now: at });
    if (!claim.ok) {
      const waited = at.getTime() - new Date(claim.window_started_at).getTime();
      return { ok: false, retry_in_minutes: Math.max(1, Math.ceil((limit.window_ms - waited) / 60_000)) };
    }
  }
  return { ok: true };
}

/** How long to wait, in words: minutes under two hours, whole hours after that. */
export function waitWords(minutes: number): string {
  if (minutes < 120) {
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  return `about ${String(Math.round(minutes / 60))} hours`;
}
