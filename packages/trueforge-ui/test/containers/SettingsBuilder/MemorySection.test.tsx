// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { MemoryVaultPage } from '@/atoms/memory/MemoryVaultPage.js';
import { AmanSetupProvider } from '@/components/AmanSetupContext.js';
import { AmanWelcome } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
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

function TestShell({ server, children }: { server: AgentUIServer; children?: ReactNode }) {
  return (
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <ShellModeProvider>
          <OpenSettingsButton />
          <TruefoundrySettingsBuilder />
          {children}
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
  fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Memories' })).toBeInTheDocument();
  });
}

describe('Settings Memory section', () => {
  it('has one Memory entry in the list and no Memory vault entry', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openSettings();

    expect(screen.getByRole('button', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Memory vault' })).not.toBeInTheDocument();
  });

  it('shows the three sub-tabs in order: Memories, Sharing, Settings', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Memories', 'Sharing', 'Settings']);
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
    expect(await screen.findByText(/nothing to share with/)).toBeInTheDocument();
  });

  it('moves between sub-tabs with the arrow keys, Home, and End', async () => {
    render(<TestShell server={createServer({ memorySetUp: true })} />);
    await openMemorySection();

    const memoriesTab = screen.getByRole('tab', { name: 'Memories' });
    const sharingTab = screen.getByRole('tab', { name: 'Sharing' });
    const settingsTab = screen.getByRole('tab', { name: 'Settings' });

    memoriesTab.focus();
    expect(memoriesTab).toHaveFocus();

    fireEvent.keyDown(memoriesTab, { key: 'ArrowRight' });
    expect(sharingTab).toHaveAttribute('aria-selected', 'true');
    expect(sharingTab).toHaveFocus();

    fireEvent.keyDown(sharingTab, { key: 'ArrowRight' });
    expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    expect(settingsTab).toHaveFocus();

    fireEvent.keyDown(settingsTab, { key: 'ArrowLeft' });
    expect(sharingTab).toHaveAttribute('aria-selected', 'true');
    expect(sharingTab).toHaveFocus();

    fireEvent.keyDown(sharingTab, { key: 'End' });
    expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    expect(settingsTab).toHaveFocus();

    fireEvent.keyDown(settingsTab, { key: 'Home' });
    expect(memoriesTab).toHaveAttribute('aria-selected', 'true');
    expect(memoriesTab).toHaveFocus();
  });

  it("opens the Memory section's Settings sub-tab from the welcome screen's memory setup link", async () => {
    const personalizationApi = {
      getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
      updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
      deleteProfile: async () => {},
    };
    render(
      <TestShell server={createServer({ memorySetUp: true })}>
        <PersonalizationProvider api={personalizationApi}>
          <AmanSetupProvider value={{ modelName: 'local-model', memoryBank: null, settingsHref: '/settings' }}>
            <AmanWelcome />
          </AmanSetupProvider>
        </PersonalizationProvider>
      </TestShell>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank in Settings › Memory' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Memory' })).toHaveAttribute('aria-current', 'page');
    // Memory is set up here, so the section alone would open on Memories; the link asks for Settings.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByText('Memory settings content')).toBeInTheDocument();
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
