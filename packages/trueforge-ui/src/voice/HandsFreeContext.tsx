'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface HandsFreeContextValue {
  active: boolean;
  setActive: (active: boolean) => void;
}

const HandsFreeContext = createContext<HandsFreeContextValue>({ active: false, setActive: () => {} });

/**
 * Global hands-free conversation state. The shell app (App.tsx) mounts this
 * above the chat UI; the header toggle flips it and the voice loop inside the
 * thread consumes it. In-memory only: hands-free never auto-starts on reload,
 * since speaking and listening both need a user gesture first.
 */
export function HandsFreeProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return <HandsFreeContext.Provider value={value}>{children}</HandsFreeContext.Provider>;
}

export function useHandsFree(): HandsFreeContextValue {
  return useContext(HandsFreeContext);
}
