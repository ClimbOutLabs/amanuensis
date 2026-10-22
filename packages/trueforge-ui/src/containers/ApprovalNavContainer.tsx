'use client';

import { useApprovalCardOffScreen } from '../hooks/useApprovalCardOffScreen.js';
import { useApprovalNav } from '../hooks/useApprovalNav.js';
import { approvalKindNoun } from '../sentinel/approvalCopy.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import { useSlot } from '../theme/SlotsProvider.js';

/**
 * Composer banner that stands in for a pending approval only while its card is scrolled out of view.
 * Its click scrolls to the card and focuses it.
 */
export function ApprovalNavContainer() {
  const ApprovalNavBanner = useSlot('ApprovalNavBanner');
  const { count, index, canPrev, canNext, goPrev, goNext, focusCurrent, currentId } = useApprovalNav();
  const sentinel = useOptionalSentinelState();
  const offScreen = useApprovalCardOffScreen(currentId);

  if (count === 0 || !offScreen) return null;

  const card = currentId === null ? undefined : sentinel?.approvalFor(currentId)?.card;
  const kind = count === 1 && card !== undefined ? approvalKindNoun(card) : undefined;

  return (
    <ApprovalNavBanner
      total={count}
      current={index + 1}
      canPrev={canPrev}
      canNext={canNext}
      onPrev={goPrev}
      onNext={goNext}
      onFocusCurrent={focusCurrent}
      kind={kind}
    />
  );
}
