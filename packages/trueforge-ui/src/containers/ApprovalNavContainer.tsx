'use client';

import type { ReactNode } from 'react';

import { useOptionalPersonalization } from '../components/PersonalizationContext.js';
import { useApprovalCardPlacement } from '../hooks/useApprovalCardPlacement.js';
import { useApprovalNav } from '../hooks/useApprovalNav.js';
import { approvalQuestion } from '../sentinel/approvalCopy.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { assistantDisplayName } from '../utils/assistantName.js';

/**
 * Strip docked to the top of the composer while a pending approval's card is scrolled out of view.
 * Its Review link scrolls to the card and focuses it. `children` gets whether the strip is docked,
 * so the composer can drop the corners it shares with the strip.
 */
export function ApprovalNavContainer({ children }: { children: (docked: boolean) => ReactNode }) {
  const ApprovalNavBanner = useSlot('ApprovalNavBanner');
  const { count, currentId, focusCurrent } = useApprovalNav();
  const sentinel = useOptionalSentinelState();
  const assistantName = assistantDisplayName(useOptionalPersonalization()?.profile?.assistant_name);
  const placement = useApprovalCardPlacement(currentId);
  const docked = count > 0 && placement === 'off-screen';

  const card = currentId === null ? undefined : sentinel?.approvalFor(currentId)?.card;
  const title = card === undefined ? undefined : approvalQuestion(card);

  return (
    <>
      {docked ? (
        <ApprovalNavBanner total={count} assistantName={assistantName} title={title} onFocusCurrent={focusCurrent} />
      ) : null}
      {children(docked)}
    </>
  );
}
