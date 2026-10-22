'use client';

import { useEffect, useState } from 'react';

/** Frames to wait for a card to mount before the composer banner stands in for it. */
const MOUNT_WAIT_FRAMES = 60;

/**
 * True when the approval's card is not on screen, so the composer banner should stand in for it. A card
 * that has not mounted yet counts as off screen; the observer takes over once it appears.
 */
export function useApprovalCardOffScreen(approvalId: string | null): boolean {
  const [offScreen, setOffScreen] = useState(true);

  useEffect(() => {
    if (approvalId === null) return;
    let frame = 0;
    let frames = 0;
    let observer: IntersectionObserver | null = null;

    const observe = () => {
      const element = Array.from(document.querySelectorAll<HTMLElement>('[data-approval-id]')).find(
        candidate => candidate.dataset.approvalId === approvalId,
      );
      if (element === undefined) {
        if (frames < MOUNT_WAIT_FRAMES) {
          frames += 1;
          frame = requestAnimationFrame(observe);
        }
        return;
      }
      observer = new IntersectionObserver(entries => {
        const latest = entries[entries.length - 1];
        setOffScreen(latest === undefined || !latest.isIntersecting);
      });
      observer.observe(element);
    };

    observe();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [approvalId]);

  return offScreen;
}
