'use client';

import { useState } from 'react';

import { MemoryTabs } from './MemoryTabs.js';
import { MemoryVaultFactsPanel, MemoryVaultSharingPanel } from './MemoryVaultPanels.js';
import { useMemoryVaultState } from './useMemoryVaultState.js';

type MemoryVaultTab = 'facts' | 'sharing';

/** Browse, edit, export, and import long-lived memory facts, and manage sharing. */
export function MemoryVaultPage() {
  const state = useMemoryVaultState();
  const [tab, setTab] = useState<MemoryVaultTab>('facts');

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory</h2>
        <p className="text-sm text-text-secondary">
          Facts the assistant remembers across chats. Edits and deletes keep the original entry in history; this list
          shows the current version.
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
