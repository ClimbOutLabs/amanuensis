'use client';

import { createContext, useContext, type ReactNode } from 'react';

type UpgradeSandboxRuntime = (providerId: string) => Promise<void>;

const SandboxRuntimeUpgradeContext = createContext<UpgradeSandboxRuntime | null>(null);

export function SandboxRuntimeUpgradeProvider({
  upgrade,
  children,
}: {
  upgrade?: UpgradeSandboxRuntime;
  children: ReactNode;
}) {
  return (
    <SandboxRuntimeUpgradeContext.Provider value={upgrade ?? null}>{children}</SandboxRuntimeUpgradeContext.Provider>
  );
}

export function useOptionalSandboxRuntimeUpgrade(): UpgradeSandboxRuntime | null {
  return useContext(SandboxRuntimeUpgradeContext);
}
