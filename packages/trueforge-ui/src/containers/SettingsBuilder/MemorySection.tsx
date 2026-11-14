'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { MemoryPagesPanel } from '@/atoms/memory/MemoryPagesPanel.js';
import { MemoryTabs } from '@/atoms/memory/MemoryTabs.js';
import {
  MemoryVaultFactsPanel,
  MemoryVaultImportExportPanel,
  MemoryVaultSharingPanel,
} from '@/atoms/memory/MemoryVaultPanels.js';
import { useMemoryPagesAvailable } from '@/atoms/memory/useMemoryPagesState.js';
import { useMemoryVaultState } from '@/atoms/memory/useMemoryVaultState.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { useOptionalPersonalization } from '@/components/PersonalizationContext.js';
import { memoryStatusReported } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import { useServerCapabilities, useServerCapabilitiesSettled } from '@/server/ServerContext.js';

// The settings panel loads only when its sub-tab mounts, like every other section module.
const MemorySettings = lazy(() => import('./MemorySettings.js'));
const LearnedProfilePanel = lazy(() => import('./LearnedProfilePanel.js'));

function MemoryPanelFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-8" role="status" aria-live="polite" aria-busy="true">
      <Spinner size={20} className="text-text-secondary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

type MemoryTab = 'memories' | 'pages' | 'sharing' | 'learned' | 'import' | 'settings';

const MEMORY_TABS: ReadonlyArray<{ id: MemoryTab; label: string }> = [
  { id: 'memories', label: 'Memories' },
  { id: 'pages', label: 'Pages' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'learned', label: 'Learned profile' },
  { id: 'import', label: 'Import and export' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Settings > Memory: one section with sub-tabs. Memories and Sharing are the memory
 * list and its sharing controls; Pages is where the pages Aman keeps are read and fixed;
 * Learned profile is the document the host learns from conversations; Import and export
 * holds the collection tools that used to sit below the list; Settings is where memory is
 * set up and tuned.
 *
 * Opens on Memories. When the server has not reported its memory once capabilities settle,
 * memory is not set up yet, so it opens on Settings instead, where setup lives. Any tab the
 * user picks while the section is open wins.
 *
 * The Learned profile tab edits fields on the personalization profile, so it is only
 * offered when the host provides personalization; without a provider the panel has
 * nothing to read or save through and must not mount. The Pages tab is offered only when
 * the server has the pages routes.
 */
export default function MemorySection() {
  const state = useMemoryVaultState();
  const settled = useServerCapabilitiesSettled();
  const reported = memoryStatusReported(useServerCapabilities());
  const personalization = useOptionalPersonalization();
  const pagesAvailable = useMemoryPagesAvailable();
  const [tab, setTab] = useState<MemoryTab>('memories');
  const userPickedRef = useRef(false);

  const tabs = MEMORY_TABS.filter(
    item => (item.id !== 'learned' || personalization !== null) && (item.id !== 'pages' || pagesAvailable),
  );

  useEffect(() => {
    if (userPickedRef.current) return;
    if (settled && !reported) {
      setTab('settings');
    }
  }, [settled, reported]);

  const selectTab = (next: MemoryTab) => {
    userPickedRef.current = true;
    setTab(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <MemoryTabs ariaLabel="Memory sections" tabs={tabs} activeTab={tab} onTabChange={selectTab} />

      {tab === 'memories' ? (
        <MemoryVaultFactsPanel
          state={state}
          onOpenSettings={() => selectTab('settings')}
          showManageCollections={false}
        />
      ) : null}
      {tab === 'pages' && pagesAvailable ? <MemoryPagesPanel /> : null}
      {tab === 'sharing' ? <MemoryVaultSharingPanel state={state} /> : null}
      {tab === 'learned' && personalization !== null ? (
        <Suspense fallback={<MemoryPanelFallback />}>
          <LearnedProfilePanel />
        </Suspense>
      ) : null}
      {tab === 'import' ? <MemoryVaultImportExportPanel state={state} /> : null}
      {tab === 'settings' ? (
        <Suspense fallback={<MemoryPanelFallback />}>
          <MemorySettings />
        </Suspense>
      ) : null}
    </div>
  );
}
