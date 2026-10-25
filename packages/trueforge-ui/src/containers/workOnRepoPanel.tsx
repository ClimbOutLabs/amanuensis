'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { useOptionalRepositoryWork } from '../components/RepositoryWorkContext.js';
import { useServerCapabilities } from '../server/ServerContext.js';

type WorkOnRepoPanelApi = {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
};

const WorkOnRepoPanelContext = createContext<WorkOnRepoPanelApi | null>(null);

/** Whether this server can clone a repo into a chat. Without a sandbox the clone can never run. */
export function useWorkOnRepoAvailable(): boolean {
  const api = useOptionalRepositoryWork();
  const capabilities = useServerCapabilities();
  return api != null && capabilities?.sandbox.enabled !== false;
}

/** Shares the "Work on a repo" panel between the composer's + menu and the panel above the composer. */
export function WorkOnRepoPanelProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const api = useMemo(() => ({ panelOpen, setPanelOpen }), [panelOpen]);
  return <WorkOnRepoPanelContext.Provider value={api}>{children}</WorkOnRepoPanelContext.Provider>;
}

export function useOptionalWorkOnRepoPanel(): WorkOnRepoPanelApi | null {
  return useContext(WorkOnRepoPanelContext);
}
