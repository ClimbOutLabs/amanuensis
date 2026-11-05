'use client';

import type { SandboxWorkspaceListing } from '@truefoundry/trueforge-core/core/sandbox/sandboxWorkspaceSchemas';
import { createContext, useContext, type FC, type ReactNode } from 'react';

export type {
  SandboxWorkspace,
  SandboxWorkspaceListing,
  SandboxWorkspaceSlot,
} from '@truefoundry/trueforge-core/core/sandbox/sandboxWorkspaceSchemas';

export type SandboxWorkspacesApi = {
  /** The chat workspaces the sandbox slots hold, joined to their chats; rejects when the server cannot be asked. */
  listSandboxWorkspaces: () => Promise<SandboxWorkspaceListing>;
};

const SandboxWorkspacesContext = createContext<SandboxWorkspacesApi | null>(null);

export const SandboxWorkspacesProvider: FC<{
  api: SandboxWorkspacesApi;
  children: ReactNode;
}> = ({ api, children }) => (
  <SandboxWorkspacesContext.Provider value={api}>{children}</SandboxWorkspacesContext.Provider>
);

export function useOptionalSandboxWorkspaces(): SandboxWorkspacesApi | null {
  return useContext(SandboxWorkspacesContext);
}
