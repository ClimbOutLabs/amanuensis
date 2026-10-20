'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { MemoryTabs } from '@/atoms/memory/MemoryTabs.js';
import { MemoryVaultFactsPanel, MemoryVaultSharingPanel } from '@/atoms/memory/MemoryVaultPanels.js';
import { useMemoryVaultState } from '@/atoms/memory/useMemoryVaultState.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { readMemoryBackend } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import { useServerCapabilities, useServerCapabilitiesSettled } from '@/server/ServerContext.js';

// The settings panel loads only when its sub-tab mounts, like every other section module.
const MemorySettings = lazy(() => import('./MemorySettings.js'));

function MemorySettingsFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-8" role="status" aria-live="polite" aria-busy="true">
      <Spinner size={20} className="text-text-secondary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

type MemoryTab = 'memories' | 'sharing' | 'settings';

const MEMORY_TABS: ReadonlyArray<{ id: MemoryTab; label: string }> = [
  { id: 'memories', label: 'Memories' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Settings > Memory: one section with three sub-tabs. Memories and Sharing are the memory
 * list and its sharing controls; Settings is where memory is set up and tuned.
 *
 * Opens on Memories. When the server reports no memory backend once capabilities settle,
 * memory is not set up yet, so it opens on Settings instead, where setup lives. Any tab the
 * user picks while the section is open wins.
 */
export default function MemorySection() {
  const capabilities = useServerCapabilities();
  const settled = useServerCapabilitiesSettled();
  const backend = readMemoryBackend(capabilities);
  const state = useMemoryVaultState();
  const [tab, setTab] = useState<MemoryTab>('memories');
  const userPickedRef = useRef(false);

  useEffect(() => {
    if (userPickedRef.current) return;
    if (settled && backend === undefined) {
      setTab('settings');
    }
  }, [settled, backend]);

  const selectTab = (next: MemoryTab) => {
    userPickedRef.current = true;
    setTab(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <MemoryTabs ariaLabel="Memory sections" tabs={MEMORY_TABS} activeTab={tab} onTabChange={selectTab} />

      {tab === 'memories' ? <MemoryVaultFactsPanel state={state} /> : null}
      {tab === 'sharing' ? <MemoryVaultSharingPanel state={state} /> : null}
      {tab === 'settings' ? (
        <Suspense fallback={<MemorySettingsFallback />}>
          <MemorySettings />
        </Suspense>
      ) : null}
    </div>
  );
}
