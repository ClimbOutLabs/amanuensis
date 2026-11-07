import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore } from '../../db/textContactStore';
import { claimTextLimits, MAX_TEST_CALLS_PER_DAY, testCallLimits, waitWords } from '../texts/textLimits';

/**
 * Counts one test call before it is placed, against the wait between calls and the day's calls together, so a call
 * either limit turns away uses up neither. Returns the words for the person when the call must wait.
 */
export async function claimTestCall({
  store,
  owner,
  at,
}: {
  store: Pick<ITextContactStore, 'claimTextSends' | 'forgetTextSends'>;
  owner: PersonOwner;
  at: Date;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { gap, day } = testCallLimits(owner);
  const claim = await claimTextLimits({ store, limits: [gap, day], at });
  if (claim.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      claim.limit === gap
        ? `That was a test call just now. Wait ${waitWords(claim.retry_in_minutes)}, then try again.`
        : `That was ${String(MAX_TEST_CALLS_PER_DAY)} test calls today. Wait ${waitWords(claim.retry_in_minutes)}, then try again.`,
  };
}
