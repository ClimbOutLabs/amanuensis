'use client';

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

import { useCompactHostContainer } from './CompactLayoutContext.js';

export function useCompactOverlayStyle(
  ref: RefObject<HTMLElement | null>,
  compact: boolean,
  contentSized = false,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  // Set for an overlay that is not inside the compact panel in the DOM.
  const host = useCompactHostContainer();

  useLayoutEffect(() => {
    if (!compact) {
      setStyle(undefined);
      return;
    }

    const container = ref.current?.closest<HTMLElement>('[data-aui-compact-layout]') ?? host;
    if (!container) return;

    const update = () => {
      const bounds = container.getBoundingClientRect();
      const height = Math.min(bounds.height * 0.85, 480);
      setStyle({
        left: bounds.left,
        bottom: window.innerHeight - bounds.bottom,
        width: bounds.width,
        height: contentSized ? 'fit-content' : height,
        maxHeight: height,
      });
    };

    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(container);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [compact, contentSized, ref, host]);

  return style;
}
