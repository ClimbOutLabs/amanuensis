// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { PersonaProvider, type PersonaApi } from '@/components/PersonaContext.js';
import { PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { RunCodeStatusProvider } from '@/components/RunCodeStatusContext.js';
import TruefoundrySettingsBuilder from '@/containers/SettingsBuilder/index.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentUIServer, SkillCatalogServer } from '@/server/types.js';
import { personaKnowledgeApiStubs } from '../../personaApiStubs.js';
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

vi.mock('@/containers/SettingsBuilder/ThemeSettings.js', () => ({
  default: () => <div>Theme settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/MemorySection.js', () => ({
  default: () => <div>Memory settings content</div>,
}));

vi.mock('@/containers/SettingsBuilder/PersonaSettings.js', () => ({
  default: () => <div>Persona settings content</div>,
}));

vi.mock('@/components/PersonalizationPanel.js', () => ({
  PersonalizationPanel: () => <div>Personalization settings content</div>,
}));

async function unavailable(): Promise<never> {
  throw new Error('Unexpected settings section call');
}

const skillCatalog: SkillCatalogServer = {
  getSkillCatalog: async () => [],
  listSkills: async () => [],
  createSkill: unavailable,
};

function createServer(options: { catalog?: boolean; skills?: boolean } = {}): AgentUIServer {
  if (options.catalog === false) {
    return createMockAgentUIServer();
  }
  return createMockAgentUIServer({
    catalog: createMockCatalog({
      ...(options.skills ? { skillCatalog } : {}),
    }),
  });
}

function SettingsControls() {
  const { setSettingsOpen } = useShellMode();
  return (
    <>
      <button type="button" onClick={() => setSettingsOpen(true)}>
        Open settings
      </button>
      <button type="button" onClick={() => setSettingsOpen(false)}>
        Switch to agent
      </button>
    </>
  );
}

function TestShell({
  server,
  children,
  personalization = false,
  personas = false,
  runCodeStatus = false,
}: {
  server?: AgentUIServer;
  children?: ReactNode;
  personalization?: boolean;
  personas?: boolean;
  runCodeStatus?: boolean;
}) {
  const content = (
    <DraftCatalogProvider>
      <ShellModeProvider>
        <SettingsControls />
        <TruefoundrySettingsBuilder />
        {children}
      </ShellModeProvider>
    </DraftCatalogProvider>
  );
  const personalizedContent = personalization ? (
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
  );
  const personaApi: PersonaApi = {
    ...personaKnowledgeApiStubs,
    listPersonas: async () => [],
    createPersona: unavailable,
    updatePersona: unavailable,
    deletePersona: unavailable,
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
  };
  const personaContent = personas ? (
    <PersonaProvider api={personaApi}>{personalizedContent}</PersonaProvider>
  ) : (
    personalizedContent
  );
  const runCodeContent = runCodeStatus ? (
    <RunCodeStatusProvider api={{ getRunCodeStatus: async () => ({ state: 'ready' }) }}>
      {personaContent}
    </RunCodeStatusProvider>
  ) : (
    personaContent
  );
  return server === undefined ? runCodeContent : <ServerProvider server={server}>{runCodeContent}</ServerProvider>;
}

async function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
}

describe('TruefoundrySettingsBuilder', () => {
  it('stays hidden while closed and when no settings catalog is available', async () => {
    const { rerender } = render(<TestShell server={createServer()} />);

    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();

    await openSettings();

    rerender(<TestShell server={createServer({ catalog: false })} />);
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();

    rerender(<TestShell />);
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('only exposes optional sections the host backs', async () => {
    const { rerender } = render(<TestShell server={createServer()} />);
    await openSettings();

    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Skills' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sandbox' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Model settings content')).toBeInTheDocument();
    });

    // The status provider wraps the tree, so adding it remounts the shell; reopen settings.
    rerender(<TestShell server={createServer({ skills: true })} runCodeStatus />);
    await openSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    await waitFor(() => {
      expect(screen.getByText('Skill settings content')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await waitFor(() => {
      expect(screen.getByText('Sandbox settings content')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Connectors' }));
    await waitFor(() => {
      expect(screen.getByText('Connector settings content')).toBeInTheDocument();
    });
  });

  it('gives model roles their own section, separate from provider inventory', async () => {
    render(<TestShell server={createServer()} />);
    await openSettings();

    // Roles are assigned here, not on the page that manages provider connections.
    fireEvent.click(screen.getByRole('tab', { name: 'Roles and Personas' }));
    await waitFor(() => {
      expect(screen.getByText('Model role settings content')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'Roles and Personas' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Model settings content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await waitFor(() => {
      expect(screen.getByText('Model settings content')).toBeInTheDocument();
    });
    expect(screen.queryByText('Model role settings content')).not.toBeInTheDocument();
  });

  it('has no Personas section of its own: personas live under Roles and Personas, not in the nav', async () => {
    const { unmount } = render(<TestShell server={createServer()} />);
    await openSettings();

    expect(screen.queryByRole('button', { name: 'Personas' })).not.toBeInTheDocument();
    unmount();

    // Even with a persona API wired up, Settings still has no standalone Personas
    // tab or content here: PersonaSettings is only ever reached via Roles and Personas.
    render(<TestShell server={createServer()} personas />);
    await openSettings();

    expect(screen.queryByRole('button', { name: 'Personas' })).not.toBeInTheDocument();
    expect(screen.queryByText('Persona settings content')).not.toBeInTheDocument();
  });

  it('shows personalization as a native Settings section when the host provides it', async () => {
    render(<TestShell server={createServer()} personalization />);
    await openSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'Personalization' }));

    await waitFor(() => {
      expect(screen.getByText('Personalization settings content')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'Personalization' })).toHaveAttribute('aria-selected', 'true');
  });

  it('resets a stale optional section when its catalog disappears', async () => {
    const { rerender } = render(<TestShell server={createServer({ skills: true })} />);
    await openSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));

    await waitFor(() => {
      expect(screen.getByText('Skill settings content')).toBeInTheDocument();
    });

    rerender(<TestShell server={createServer()} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    });
    await waitFor(() => {
      expect(screen.getByText('Model settings content')).toBeInTheDocument();
    });
    expect(screen.queryByRole('tab', { name: 'Skills' })).not.toBeInTheDocument();
  });

  it('closes on Escape without leaking the event to a parent handler', async () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <TestShell server={createServer()} />
      </div>,
    );
    await openSettings();

    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });

    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  async function expectCatalogsRefreshOnClose(close: () => void) {
    const getModels = vi.fn(async () => []);
    const getSkills = vi.fn(async () => []);
    const getMcp = vi.fn(async () => []);
    const getCapabilities = vi.fn(async () => ({
      data: { sandbox: { enabled: true }, skill: { enabled: true } },
    }));
    const server = createMockAgentUIServer({
      catalog: createMockCatalog(),
      getModels,
      getSkills,
      getMcp,
      getCapabilities,
    });
    render(<TestShell server={server} />);
    await openSettings();
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    const capabilitiesCallsAfterOpen = getCapabilities.mock.calls.length;

    close();

    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
    await waitFor(() => expect(getModels).toHaveBeenCalledOnce());
    expect(getSkills).toHaveBeenCalledOnce();
    expect(getMcp).toHaveBeenCalledOnce();
    await waitFor(() => expect(getCapabilities.mock.calls.length).toBeGreaterThan(capabilitiesCallsAfterOpen));
  }

  it('refreshes composer catalogs when settings close', async () => {
    await expectCatalogsRefreshOnClose(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    });
  });

  it('refreshes composer catalogs when leaving settings for a chat or named agent', async () => {
    await expectCatalogsRefreshOnClose(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to agent' }));
    });
  });

  it('highlights exactly the tab whose section is shown, for every tab', async () => {
    render(<TestShell server={createServer({ skills: true })} personalization runCodeStatus />);
    await openSettings();

    const cases: Array<{ tab: string; content?: string }> = [
      { tab: 'Models', content: 'Model settings content' },
      { tab: 'Roles and Personas', content: 'Model role settings content' },
      { tab: 'Connectors', content: 'Connector settings content' },
      { tab: 'Memory', content: 'Memory settings content' },
      { tab: 'Themes', content: 'Theme settings content' },
      { tab: 'Skills', content: 'Skill settings content' },
      { tab: 'Sandbox', content: 'Sandbox settings content' },
      { tab: 'Personalization', content: 'Personalization settings content' },
    ];
    for (const { tab, content } of cases) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));

      const selected = screen.getAllByRole('tab').filter(item => item.getAttribute('aria-selected') === 'true');
      expect(selected.map(item => item.textContent)).toEqual([tab]);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', selected[0]?.id);
      if (content !== undefined) {
        await waitFor(() => {
          expect(screen.getByText(content)).toBeInTheDocument();
        });
      }
    }
  });

  it('opens on Models with Models highlighted on a fresh open', async () => {
    render(<TestShell server={createServer({ skills: true })} personalization runCodeStatus />);
    await openSettings();

    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-models');
    await waitFor(() => {
      expect(screen.getByText('Model settings content')).toBeInTheDocument();
    });
  });

  it('keeps the highlighted tab on the section shown after closing and reopening', async () => {
    render(<TestShell server={createServer()} personalization />);
    await openSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Personalization' }));
    await waitFor(() => {
      expect(screen.getByText('Personalization settings content')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openSettings();

    expect(screen.getByRole('tab', { name: 'Personalization' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => {
      expect(screen.getByText('Personalization settings content')).toBeInTheDocument();
    });
  });

  it('moves between tabs with the arrow, Home and End keys', async () => {
    render(<TestShell server={createServer()} />);
    await openSettings();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Models' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Roles and Personas' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Roles and Personas' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Roles and Personas' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Themes' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Themes' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveFocus();
  });

  it('scrolls the selected tab into view inside the tab strip', async () => {
    const rectOf = (left: number, width: number): DOMRect => ({
      x: left,
      y: 0,
      left,
      top: 0,
      width,
      height: 0,
      right: left + width,
      bottom: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tablist') return rectOf(0, 300);
      if (this.getAttribute('aria-selected') === 'true') return rectOf(400, 100);
      return rectOf(0, 100);
    });
    try {
      render(<TestShell server={createServer()} />);
      await openSettings();

      // The selected tab sits at 400 to 500 inside a 300 wide strip, so the strip scrolls to centre it.
      expect(screen.getByRole('tablist', { name: 'Settings sections' }).scrollLeft).toBe(300);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not reopen settings when a stale optional section is reset while closed', async () => {
    const { rerender } = render(<TestShell server={createServer({ skills: true })} />);
    await openSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    await waitFor(() => {
      expect(screen.getByText('Skill settings content')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();

    rerender(<TestShell server={createServer()} />);

    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
