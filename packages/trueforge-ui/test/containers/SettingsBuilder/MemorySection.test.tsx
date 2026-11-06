// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { MemoryVaultPage } from '@/atoms/memory/MemoryVaultPage.js';
import { PersonalizationProvider } from '@/components/PersonalizationContext.js';
import TruefoundrySettingsBuilder from '@/containers/SettingsBuilder/index.js';
import type { MemoryVaultCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentBuilderCapabilitiesResponse, AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

vi.mock('@/containers/SettingsBuilder/ModelSettings.js', () => ({
  default: () => <div>Model settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/ModelRoleSettings.js', () => ({
  default: () => <div>Model role settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/ConnectorSettings.js', () => ({
  default: () => <div>Connector settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/SkillSettings.js', () => ({
  default: () => <div>Skill settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/SandboxSettings.js', () => ({
  default: () => <div>Sandbox settings content</div>,
}));

vi.mock('@/components/PersonalizationPanel.js', () => ({
  PersonalizationPanel: () => <div>Personalization settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/MemorySettings.js', () => ({
  default: () => <div>Memory settings content</div>,
}));

/** Memory-defaults fixture per the generated SDK type; only `backend` is read here. */
const MEMORY_DEFAULTS = {
  backend: 'markdown',
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMaxItems: 50,
  recallMaxEntities: 10,
  recallMinScore: 0.6,
  curatedEnabled: true,
  curatedMaxModels: 3,
  curatedMaxTokens: 512,
  prerecallGateEnabled: false,
  reflectEnabled: true,
  reflectBudget: 'low',
  reflectMaxTokens: 512,
  reflectTimeoutMs: 8000,
} satisfies TrueForgeApi.MemoryDefaultsCapability;

const vaultCatalog: MemoryVaultCatalog = {
  listEntries: async () => [
    { id: 'fact-1', text: 'The user drinks tea in the morning.', timestamp: '2026-10-15T08:00:00.000Z', persona: null },
  ],
  getSummaryStatus: async () => ({ summaryPending: false }),
  updateEntry: async options => ({
    id: options.entryId,
    text: options.text,
    timestamp: '2026-10-15T08:00:00.000Z',
    persona: null,
  }),
  deleteEntry: async () => {},
  exportEntries: async () => ({ namespace: '', exportedAt: '2026-10-15T08:00:00.000Z', entries: [] }),
  importEntries: async () => ({ namespace: '', imported: 0 }),
  getSharing: async () => ({ shares: {} }),
  updateSharing: async sharing => sharing,
};

function createServer(options: { memorySetUp: boolean }): AgentUIServer {
  const response = {
    data: {
      sandbox: { enabled: true },
      skill: { enabled: true },
      settings: { enabled: true },
      ...(options.memorySetUp ? { memoryDefaults: MEMORY_DEFAULTS } : {}),
    },
  } satisfies AgentBuilderCapabilitiesResponse & {
    data: AgentBuilderCapabilitiesResponse['data'] & { memoryDefaults?: TrueForgeApi.MemoryDefaultsCapability };
  };
  const base = createMockAgentUIServer({
    catalog: createMockCatalog(),
    getCapabilities: async () => response,
  });
  // The vault is a companion surface the adapter attaches beside the typed server.
  const server = { ...base, memoryVault: vaultCatalog };
  return server;
}

function OpenSettingsButton() {
  const { setSettingsOpen } = useShellMode();
  return (
    <button type="button" onClick={() => setSettingsOpen(true)}>
      Open settings
    </button>
  );
}

function TestShell({
  server,
  children,
  withPersonalization = true,
}: {
  server: AgentUIServer;
  children?: ReactNode;
  withPersonalization?: boolean;
}) {
  const content = (
    <>
      <OpenSettingsButton />
      <TruefoundrySettingsBuilder />
      {children}
    </>
  );
  return (
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <ShellModeProvider>
          {withPersonalization ? (
            <PersonalizationProvider
              api={{
                getProfile: async () => null,
                updateProfile: async profile => profile,
                deleteProfile: async () => {},
              }}
            >
              {content}
            </PersonalizationProvider>
          ) : (
            content
          )}
        </ShellModeProvider>
      </DraftCatalogProvider>
    </ServerProvider>
  );
}

async function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
}

async function openMemorySection() {
  await openSettings();
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Memories' })).toBeInTheDocument();
  });
}

describe('Settings Memory section', () => {
  it('has one Memory entry in the list and no Memory vault entry', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openSettings();

    expect(screen.getByRole('tab', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Memory vault' })).not.toBeInTheDocument();
  });

  it('shows the five sub-tabs in order: Memories, Sharing, Learned profile, Import and export, Settings', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    const memoryTabs = screen.getByRole('tablist', { name: 'Memory sections' });
    expect(
      within(memoryTabs)
        .getAllByRole('tab')
        .map(tab => tab.textContent),
    ).toEqual(['Memories', 'Sharing', 'Learned profile', 'Import and export', 'Settings']);
  });

  it('opens on Memories when memory is set up', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    expect(screen.getByRole('tab', { name: 'Memories' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('The user drinks tea in the morning.')).toBeInTheDocument();
  });

  it('opens on Settings when memory is not set up yet', async () => {
    render(<TestShell server={createServer({ memorySetUp: false })} />);
    await openMemorySection();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByText('Memory settings content')).toBeInTheDocument();
  });

  it('shows the Sharing sub-tab content when picked', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    fireEvent.click(screen.getByRole('tab', { name: 'Sharing' }));
    expect(screen.getByRole('tab', { name: 'Sharing' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/nothing to share\./)).toBeInTheDocument();
  });

  it('shows the Learned profile block on its own sub-tab', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    fireEvent.click(screen.getByRole('tab', { name: 'Learned profile' }));
    expect(screen.getByRole('tab', { name: 'Learned profile' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Learned profile' })).toBeInTheDocument();
    expect(screen.getByText(/updates this from your conversations/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toBeInTheDocument();
  });

  it('hides the Learned profile tab when the host has no personalization provider', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} withPersonalization={false} />);
    await openMemorySection();

    const memoryTabs = screen.getByRole('tablist', { name: 'Memory sections' });
    expect(
      within(memoryTabs)
        .getAllByRole('tab')
        .map(tab => tab.textContent),
    ).toEqual(['Memories', 'Sharing', 'Import and export', 'Settings']);
    expect(await screen.findByText('The user drinks tea in the morning.')).toBeInTheDocument();
  });

  it('shows export and import on their own sub-tab, not below the list', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    expect(await screen.findByText('The user drinks tea in the morning.')).toBeInTheDocument();
    expect(screen.queryByText('Export, import, and topics')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Import and export' }));
    expect(screen.getByRole('tab', { name: 'Import and export' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByText('Export, import, and topics'));
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByLabelText('Import memory JSON file')).toBeInTheDocument();
  });

  it('moves between sub-tabs with the arrow keys, Home, and End', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    const memoriesTab = screen.getByRole('tab', { name: 'Memories' });
    const sharingTab = screen.getByRole('tab', { name: 'Sharing' });
    const learnedTab = screen.getByRole('tab', { name: 'Learned profile' });
    const importTab = screen.getByRole('tab', { name: 'Import and export' });
    const settingsTab = screen.getByRole('tab', { name: 'Settings' });

    memoriesTab.focus();
    expect(memoriesTab).toHaveFocus();

    fireEvent.keyDown(memoriesTab, { key: 'ArrowRight' });
    expect(sharingTab).toHaveAttribute('aria-selected', 'true');
    expect(sharingTab).toHaveFocus();

    fireEvent.keyDown(sharingTab, { key: 'ArrowRight' });
    expect(learnedTab).toHaveAttribute('aria-selected', 'true');
    expect(learnedTab).toHaveFocus();

    fireEvent.keyDown(learnedTab, { key: 'ArrowRight' });
    expect(importTab).toHaveAttribute('aria-selected', 'true');
    expect(importTab).toHaveFocus();

    fireEvent.keyDown(importTab, { key: 'ArrowRight' });
    expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    expect(settingsTab).toHaveFocus();

    fireEvent.keyDown(settingsTab, { key: 'ArrowLeft' });
    expect(importTab).toHaveAttribute('aria-selected', 'true');
    expect(importTab).toHaveFocus();

    fireEvent.keyDown(importTab, { key: 'End' });
    expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    expect(settingsTab).toHaveFocus();

    fireEvent.keyDown(settingsTab, { key: 'Home' });
    expect(memoriesTab).toHaveAttribute('aria-selected', 'true');
    expect(memoriesTab).toHaveFocus();
  });
});

describe('MemoryVaultPage', () => {
  it('shows the Memories and Sharing tabs under a plain Memory heading', async () => {
    render(
      <ServerProvider server={createServer({ memorySetUp: true })}>
        <MemoryVaultPage />
      </ServerProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Memories', 'Sharing']);
    expect(await screen.findByText('The user drinks tea in the morning.')).toBeInTheDocument();
  });
});
