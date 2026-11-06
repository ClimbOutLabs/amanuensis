import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore } from '../../db/textContactStore';
import { claimTextLimits, DAY_MS, ownerLimitKey, waitWords } from '../texts/textLimits';

/** Each Try it call is paid and rings a real phone, so the button waits between calls and stops for the day. */
const TEST_CALL_GAP_MS = 2 * 60_000;
const MAX_TEST_CALLS_PER_DAY = 5;

/**
 * Counts one test call before it is placed. The short wait is claimed first, so a call it turns away uses up none of
 * the day's calls. Returns the words for the person when the call must wait.
 */
export async function claimTestCall({
  store,
  owner,
  at,
}: {
  store: Pick<ITextContactStore, 'claimTextSend' | 'forgetTextSends'>;
  owner: PersonOwner;
  at: Date;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const gap = await claimTextLimits({
    store,
    limits: [{ key: ownerLimitKey({ scope: 'test-call-gap', owner }), window_ms: TEST_CALL_GAP_MS, max: 1 }],
    at,
  });
  if (!gap.ok) {
    return {
      ok: false,
      message: `That was a test call just now. Wait ${waitWords(gap.retry_in_minutes)}, then try again.`,
    };
  }
  const day = await claimTextLimits({
    store,
    limits: [{ key: ownerLimitKey({ scope: 'test-call-day', owner }), window_ms: DAY_MS, max: MAX_TEST_CALLS_PER_DAY }],
    at,
  });
  if (!day.ok) {
    return {
      ok: false,
      message: `That was ${String(MAX_TEST_CALLS_PER_DAY)} test calls today. Wait ${waitWords(day.retry_in_minutes)}, then try again.`,
    };
  }
  return { ok: true };
}
