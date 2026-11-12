'use client';

import { lazy, Suspense, useState } from 'react';

import { MemoryPagesPanel } from '@/atoms/memory/MemoryPagesPanel.js';
import { MemoryTabs } from '@/atoms/memory/MemoryTabs.js';
import { MemoryVaultFactsPanel, MemoryVaultSharingPanel } from '@/atoms/memory/MemoryVaultPanels.js';
import { useMemoryPagesAvailable } from '@/atoms/memory/useMemoryPagesState.js';
import { useMemoryVaultState } from '@/atoms/memory/useMemoryVaultState.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';

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

type MemoryTab = 'memories' | 'pages' | 'sharing' | 'settings';

const MEMORY_TABS: ReadonlyArray<{ id: MemoryTab; label: string }> = [
  { id: 'memories', label: 'Memories' },
  { id: 'pages', label: 'Pages' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Settings > Memory: one section with sub-tabs. Memories and Sharing are the memory
 * list and its sharing controls; Pages is where the pages Aman keeps are read and fixed; Settings is where memory is set up and tuned.
 *
 * Opens on Memories.
 */
export default function MemorySection() {
  const state = useMemoryVaultState();
  const pagesAvailable = useMemoryPagesAvailable();
  const tabs = pagesAvailable ? MEMORY_TABS : MEMORY_TABS.filter(item => item.id !== 'pages');
  const [tab, setTab] = useState<MemoryTab>('memories');

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <MemoryTabs ariaLabel="Memory sections" tabs={tabs} activeTab={tab} onTabChange={setTab} />

      {tab === 'memories' ? <MemoryVaultFactsPanel state={state} onOpenSettings={() => setTab('settings')} /> : null}
      {tab === 'pages' && pagesAvailable ? <MemoryPagesPanel /> : null}
      {tab === 'sharing' ? <MemoryVaultSharingPanel state={state} /> : null}
      {tab === 'settings' ? (
        <Suspense fallback={<MemorySettingsFallback />}>
          <MemorySettings />
        </Suspense>
      ) : null}
    </div>
  );
}
