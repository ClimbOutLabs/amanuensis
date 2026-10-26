'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const CompactLayoutContext = createContext(false);

export function CompactLayoutProvider({ children }: { children: ReactNode }) {
  return <CompactLayoutContext.Provider value>{children}</CompactLayoutContext.Provider>;
}

type CompactHost = { container: HTMLElement | null; setContainer: (element: HTMLElement | null) => void };

const CompactHostContext = createContext<CompactHost | null>(null);

/**
 * Lets an overlay mounted above a compact layout (the app shell's one bug report dialog) find the
 * panel it should sit in, since it is not a DOM descendant of that panel.
 */
export function CompactHostProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const host = useMemo<CompactHost>(() => ({ container, setContainer }), [container]);
  return <CompactHostContext.Provider value={host}>{children}</CompactHostContext.Provider>;
}

/** The panel a compact layout registered, or null when none is showing. */
export function useCompactHostContainer(): HTMLElement | null {
  return useContext(CompactHostContext)?.container ?? null;
}

/** Ref callback for the compact layout's panel element. Stable, so it does not re-register each render. */
export function useCompactContainerRef(): (element: HTMLElement | null) => void {
  const setContainer = useContext(CompactHostContext)?.setContainer;
  return useCallback(
    (element: HTMLElement | null) => {
      setContainer?.(element);
    },
    [setContainer],
  );
}

export function useCompactLayout() {
  const inCompactLayout = useContext(CompactLayoutContext);
  const hostContainer = useCompactHostContainer();
  return inCompactLayout || hostContainer !== null;
}
