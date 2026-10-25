import { useEffect, useRef } from 'react';

/** A click that started outside is swallowed only if it lands within this long. */
const SWALLOW_WINDOW_MS = 1000;

/** Eats the click that follows a closing press, so closing never also presses what is underneath. */
function swallowNextClick(): void {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const finish = () => {
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('click', swallowThenFinish, true);
    window.clearTimeout(timer);
  };
  const swallowThenFinish = (event: Event) => {
    swallow(event);
    finish();
  };
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('click', swallowThenFinish, true);
  const timer = window.setTimeout(finish, SWALLOW_WINDOW_MS);
}

/**
 * Closes an open panel on a press outside it or on Escape. The outside press only closes the panel:
 * it never reaches whatever is under the pointer.
 */
export function useLightDismiss({
  open,
  isInside,
  onDismiss,
}: {
  open: boolean;
  isInside: (target: Element) => boolean;
  onDismiss: () => void;
}): void {
  const latest = useRef({ isInside, onDismiss });
  latest.current = { isInside, onDismiss };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || latest.current.isInside(target)) return;
      event.preventDefault();
      event.stopPropagation();
      swallowNextClick();
      latest.current.onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      latest.current.onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
}
