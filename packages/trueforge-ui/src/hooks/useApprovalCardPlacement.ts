'use client';

import { useEffect, useState } from 'react';

/** Frames to wait for a card to mount before reporting it missing. */
const MOUNT_WAIT_FRAMES = 60;

/**
 * Where an approval's card is: `off-screen` (the composer banner stands in), `on-screen` (neither
 * banner shows), or `missing` (no card rendered, so the thread banner stands in). `checking` until
 * the first answer.
 */
export type ApprovalCardPlacement = 'checking' | 'on-screen' | 'off-screen' | 'missing';

export function useApprovalCardPlacement(approvalId: string | null): ApprovalCardPlacement {
  const [reported, setReported] = useState<{ approvalId: string; placement: ApprovalCardPlacement } | null>(null);

  useEffect(() => {
    if (approvalId === null) return;
    let frame = 0;
    let frames = 0;
    let observer: IntersectionObserver | null = null;
    const report = (placement: ApprovalCardPlacement) => setReported({ approvalId, placement });

    const observe = () => {
      const element = Array.from(document.querySelectorAll<HTMLElement>('[data-approval-id]')).find(
        candidate => candidate.dataset.approvalId === approvalId,
      );
      if (element === undefined) {
        if (frames < MOUNT_WAIT_FRAMES) {
          frames += 1;
          frame = requestAnimationFrame(observe);
        } else {
          report('missing');
        }
        return;
      }
      report('on-screen');
      observer = new IntersectionObserver(entries => {
        const latest = entries[entries.length - 1];
        report(latest === undefined || !latest.isIntersecting ? 'off-screen' : 'on-screen');
      });
      observer.observe(element);
    };

    observe();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [approvalId]);

  return reported !== null && reported.approvalId === approvalId ? reported.placement : 'checking';
}
