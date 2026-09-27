'use client';

import type { ImplementationPlanGrant } from '@truefoundry/trueforge-core/core/mcp/implementationPlanGrant';
import { createContext, useContext, type FC, type ReactNode } from 'react';

export type {
  ImplementationPlan,
  ImplementationPlanGrant,
} from '@truefoundry/trueforge-core/core/mcp/implementationPlanGrant';

export type ImplementationPlanGrantApi = {
  listImplementationPlanGrants: (sessionId: string) => Promise<ImplementationPlanGrant[]>;
  revokeImplementationPlanGrant: (input: { sessionId: string; grantId: string }) => Promise<void>;
};

const ImplementationPlanGrantContext = createContext<ImplementationPlanGrantApi | null>(null);

export const ImplementationPlanGrantProvider: FC<{
  api: ImplementationPlanGrantApi;
  children: ReactNode;
}> = ({ api, children }) => (
  <ImplementationPlanGrantContext.Provider value={api}>{children}</ImplementationPlanGrantContext.Provider>
);

export function useOptionalImplementationPlanGrants(): ImplementationPlanGrantApi | null {
  return useContext(ImplementationPlanGrantContext);
}

export function useImplementationPlanGrants(): ImplementationPlanGrantApi {
  const context = useOptionalImplementationPlanGrants();
  if (context == null) {
    throw new Error('useImplementationPlanGrants must be used within an ImplementationPlanGrantProvider.');
  }
  return context;
}
