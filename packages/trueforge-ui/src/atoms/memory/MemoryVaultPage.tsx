'use client';

import { useState } from 'react';

import { MemoryTabs } from './MemoryTabs.js';
import { MemoryVaultFactsPanel, MemoryVaultSharingPanel } from './MemoryVaultPanels.js';
import { useMemoryVaultState } from './useMemoryVaultState.js';

type MemoryVaultTab = 'facts' | 'sharing';

/** Browse, search, edit, forget, export, and import what Aman remembers, and manage sharing. */
export function MemoryVaultPage() {
  const state = useMemoryVaultState();
  const [tab, setTab] = useState<MemoryVaultTab>('facts');

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory</h2>
        <p className="text-sm text-text-secondary">
          Everything Aman remembers from your chats. Read, search, edit, copy, or forget any of it.
        </p>
      </div>

      <MemoryTabs
        ariaLabel="Memory sections"
        tabs={[
          { id: 'facts', label: 'Memories' },
          { id: 'sharing', label: 'Sharing' },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      />

      {tab === 'sharing' ? <MemoryVaultSharingPanel state={state} /> : <MemoryVaultFactsPanel state={state} />}
    </div>
  );
}
