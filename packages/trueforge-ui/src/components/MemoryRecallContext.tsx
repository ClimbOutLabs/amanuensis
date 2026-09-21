'use client';

import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * One turn's host-injected memory recall and/or learned-profile write, if either happened.
 * Canonical declaration for the `MemoryRecallApi` contract below; `trueforge-agent-server-adapter`
 * (`chatServer.ts`) re-exports this same type via a type-only import instead of restating its
 * shape, so the two stay a single contract rather than two that can drift independently. The
 * import is type-only (erased at build time under this package's `verbatimModuleSyntax`), so it
 * adds no runtime dependency from that plugin onto this component tree.
 */
export type MemoryTurnContext = {
  turnId: string;
  recall?: TrueForgeApi.MemoryRecallPersistedEvent;
  profile?: TrueForgeApi.ProfileLearnedPersistedEvent;
};

export type MemoryRecallApi = {
  /** Every `aman.memory.recall` / `aman.profile.learned` event this session has recorded, by turn. */
  listMemoryTurnContext: (sessionId: string) => Promise<MemoryTurnContext[]>;
};

const MemoryRecallContext = createContext<MemoryRecallApi | null>(null);

/**
 * Opt-in: hosts that expose Amanuensis-style memory recall wrap their tree in this provider (see
 * `ImplementationPlanGrantProvider` for the same pattern). Absent it, `useOptionalMemoryRecall`
 * returns `null` and the durable memory-context card simply never renders.
 */
export const MemoryRecallProvider: FC<{ api: MemoryRecallApi; children: ReactNode }> = ({ api, children }) => (
  <MemoryRecallContext.Provider value={api}>{children}</MemoryRecallContext.Provider>
);

export function useOptionalMemoryRecall(): MemoryRecallApi | null {
  return useContext(MemoryRecallContext);
}
