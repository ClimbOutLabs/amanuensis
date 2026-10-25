import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Room kept between a menu and the screen edge, and between a menu and its button, in CSS pixels. */
const SCREEN_MARGIN = 8;
const ANCHOR_GAP = 4;

export type MenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when the menu opens downward from the button. */
  top?: number;
  /** Set when the menu opens upward from the button. */
  bottom?: number;
};

/**
 * Where a menu goes so it always fits on screen: on the side of its button with more room, no
 * taller than that room (the menu scrolls inside), and slid sideways to stay inside the edges.
 */
export function fitMenuToScreen({
  anchor,
  viewport,
  width,
  height,
}: {
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left'>;
  viewport: { width: number; height: number };
  width: number;
  height: number;
}): MenuPlacement {
  const fittedWidth = Math.min(width, viewport.width - SCREEN_MARGIN * 2);
  const left = Math.min(Math.max(anchor.left, SCREEN_MARGIN), viewport.width - fittedWidth - SCREEN_MARGIN);
  const below = viewport.height - anchor.bottom - ANCHOR_GAP - SCREEN_MARGIN;
  const above = anchor.top - ANCHOR_GAP - SCREEN_MARGIN;
  if (below >= above) {
    return { left, width: fittedWidth, top: anchor.bottom + ANCHOR_GAP, maxHeight: Math.min(height, below) };
  }
  return {
    left,
    width: fittedWidth,
    bottom: viewport.height - anchor.top + ANCHOR_GAP,
    maxHeight: Math.min(height, above),
  };
}

/** Fixed-position style that keeps an open menu on screen, kept current as the page scrolls or resizes. */
export function useFitOnScreen({
  open,
  anchorRef,
  width,
  height,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  width: number;
  height: number;
}): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (anchor === undefined) return;
      const placement = fitMenuToScreen({
        anchor,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        width,
        height,
      });
      setStyle({ position: 'fixed', ...placement, overflowY: 'auto' });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, width, height]);
  return style;
}
