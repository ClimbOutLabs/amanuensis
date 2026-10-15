// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { DraftCompositeSelector } from '@/atoms/draft/DraftCompositeSelector.js';
import { CompactLayoutProvider } from '@/atoms/lib/CompactLayoutContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSkill, AgentSpec, CatalogServer, SkillCatalogServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

let agentSpec: AgentSpec;
const updateAgentSpec = vi.fn();
const setSettingsOpen = vi.fn();

async function unavailable(): Promise<never> {
  throw new Error('Unexpected settings catalog call');
}

const skillCatalog: SkillCatalogServer = {
  getSkillCatalog: async () => [],
  listSkills: async () => [],
  createSkill: unavailable,
};

const settingsCatalog = createMockCatalog({ skillCatalog });

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

vi.mock('@/server/ShellModeContext.js', () => ({
  useOptionalShellMode: () => ({ setSettingsOpen }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function renderSelector({
  onAttach,
  getCapabilities,
  getSkills,
  getMcp,
  catalog = settingsCatalog,
  compact = false,
}: {
  onAttach?: () => void;
  getCapabilities?: () => Promise<{
    data: {
      sandbox: { enabled: boolean };
      skill: { enabled: boolean; reason?: string };
      settings?: { enabled: boolean };
    };
  }>;
  getSkills?: () => Promise<AgentSkill[]>;
  getMcp?: () => Promise<{ id: string; name: string; authenticated: boolean }[]>;
  catalog?: CatalogServer | null;
  compact?: boolean;
} = {}) {
  const server = createMockAgentUIServer({
    ...(catalog === null ? {} : { catalog }),
    getCapabilities:
      getCapabilities ??
      (async () => ({
        data: {
          sandbox: { enabled: true },
          skill: { enabled: true },
        },
      })),
    getModels: async () => [],
    getSkills: getSkills ?? (async () => [{ id: 'research', name: 'Research' }]),
    getMcp:
      getMcp ??
      (async () => [
        { id: 'github', name: 'GitHub', authenticated: true },
        { id: 'slack', name: 'Slack', authenticated: true },
      ]),
  });
  const selector = (
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <DraftCompositeSelector onAttach={onAttach} />
      </DraftCatalogProvider>
    </ServerProvider>
  );
  return render(compact ? <CompactLayoutProvider>{selector}</CompactLayoutProvider> : selector);
}

describe('DraftCompositeSelector', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      mcpServers: [{ id: 'slack', name: 'Slack' }],
      skills: [{ id: 'research', name: 'Research' }],
    };
    updateAgentSpec.mockReset();
    setSettingsOpen.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the selected add-on count only for a valid model', () => {
    const view = renderSelector();
    const addOnsTrigger = screen.getByRole('button', { name: 'Add-ons (2)' });
    expect(addOnsTrigger).toHaveTextContent('Add-ons');
    expect(addOnsTrigger).toHaveTextContent('2');
    fireEvent.click(addOnsTrigger);
    expect(screen.getByRole('dialog', { name: 'Add to composer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connectors/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Skills/ })).toBeInTheDocument();
    // Capabilities is a fork-only tab (upstream's picker has only Connectors and
    // Skills); it is not gated behind a valid model, unlike the Add-ons trigger itself.
    expect(screen.getByRole('button', { name: /Capabilities/ })).toBeInTheDocument();

    agentSpec = { ...agentSpec, model: { name: '  ' } };
    view.rerender(
      <ServerProvider server={createMockAgentUIServer()}>
        <DraftCatalogProvider>
          <DraftCompositeSelector />
        </DraftCatalogProvider>
      </ServerProvider>,
    );
    expect(screen.queryByRole('button', { name: /Connectors/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add to composer' })).not.toBeInTheDocument();
  });

  it('keeps registry skills plain in the draft composer', async () => {
    const loadVersions = vi.fn(async () => []);
    const skill: AgentSkill = Object.assign(
      { id: 'agent-skill:acme/team-a/echo:3', name: 'echo' },
      { version: 3, loadVersions },
    );
    renderSelector({ getSkills: async () => [skill] });

    fireEvent.click(screen.getByRole('button', { name: /Add-ons/ }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(await screen.findByRole('menuitemcheckbox', { name: /echo/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select version for echo' })).not.toBeInTheDocument();
    expect(loadVersions).not.toHaveBeenCalled();
  });

  it('uses contrasting search surfaces in light and dark themes', () => {
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    expect(screen.getByPlaceholderText('Search connectors...')).toHaveClass(
      'border-input-border',
      'bg-secondary-bg',
      'dark:bg-primary-bg',
    );
  });

  it('filters the complete connector catalog client-side', async () => {
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    expect(await screen.findByRole('menuitemcheckbox', { name: /GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Slack/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search connectors...'), { target: { value: 'git' } });

    expect(screen.getByRole('menuitemcheckbox', { name: /GitHub/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Slack/ })).not.toBeInTheDocument();
  });

  it('shows selected connectors and skills in the picker tooltip', () => {
    renderSelector();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Add-ons (2)' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Connectors: Slack');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Skills: Research');
  });

  it('truncates connector tooltip names after 4 with a remainder count', () => {
    agentSpec = {
      ...agentSpec,
      mcpServers: [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gamma' },
        { id: 'd', name: 'Delta' },
        { id: 'e', name: 'Epsilon' },
        { id: 'f', name: 'Zeta' },
      ],
      skills: [],
    };
    renderSelector();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Add-ons (6)' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Connectors: Alpha, Beta, Gamma, Delta +2');
  });

  it('renders attachment as a standalone tooltip control', () => {
    const onAttach = vi.fn();
    renderSelector({ onAttach });

    const attach = screen.getByRole('button', { name: 'Attach a file' });
    fireEvent.mouseEnter(attach);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Attach a file');
    fireEvent.click(attach);
    expect(onAttach).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Add to composer' })).not.toBeInTheDocument();
  });

  it('groups compact tools and attachment actions under a plus menu', () => {
    const onAttach = vi.fn();
    renderSelector({ onAttach, compact: true });

    expect(screen.queryByRole('button', { name: 'Add-ons (2)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach a file' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Add-ons (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach a file' }));

    expect(onAttach).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add-ons (2)' }));
    expect(screen.getByRole('dialog', { name: 'Add to composer' })).toBeInTheDocument();
  });

  it('debounces connector changes into one draft update', async () => {
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GitHub/ }));

    expect(updateAgentSpec).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(updateAgentSpec).toHaveBeenCalledWith({
      mcpServers: [
        { id: 'slack', name: 'Slack' },
        { id: 'github', name: 'GitHub' },
      ],
      skills: [{ id: 'research', name: 'Research' }],
    });
  });

  it('treats omitted capabilities as enabled and patches only capability branches', async () => {
    agentSpec = { ...agentSpec, config: {} };
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Capabilities/ }));

    const generativeUi = screen.getByRole('switch', { name: 'Generative UI' });
    expect(generativeUi).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(generativeUi);

    expect(updateAgentSpec).toHaveBeenCalledWith({
      config: {
        generativeUi: { enabled: false },
        dynamicSubAgents: { enabled: true },
        askUserQuestions: { enabled: true },
      },
    });
  });

  it('folds dirty connector toggles into a capability update', async () => {
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /GitHub/ }));
    fireEvent.click(screen.getByRole('button', { name: /Capabilities/ }));
    fireEvent.click(screen.getByRole('switch', { name: 'Generative UI' }));

    expect(updateAgentSpec).toHaveBeenCalledTimes(1);
    expect(updateAgentSpec).toHaveBeenCalledWith({
      mcpServers: [
        { id: 'slack', name: 'Slack' },
        { id: 'github', name: 'GitHub' },
      ],
      skills: [{ id: 'research', name: 'Research' }],
      config: {
        generativeUi: { enabled: false },
        dynamicSubAgents: { enabled: true },
        askUserQuestions: { enabled: true },
      },
    });
  });

  it('opens settings from the empty connectors state', async () => {
    renderSelector({ getMcp: async () => [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    fireEvent.click(await screen.findByRole('button', { name: /Please configure Connectors in the settings/ }));

    expect(setSettingsOpen).toHaveBeenCalledWith(true, 'connectors');
    expect(screen.queryByRole('dialog', { name: 'Add to composer' })).not.toBeInTheDocument();
  });

  it('opens settings from the empty skills state', async () => {
    renderSelector({ getSkills: async () => [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Please configure Skills in the settings/ }));

    expect(setSettingsOpen).toHaveBeenCalledWith(true, 'skills');
  });

  it('explains the sandbox requirement when skills are unavailable', async () => {
    renderSelector({
      getCapabilities: async () => ({
        data: {
          sandbox: { enabled: false },
          skill: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' },
        },
      }),
      getSkills: async () => [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('Skills run in a sandbox, which is not configured.');
    // No provider form exists to send the user to, so the empty state offers no settings link.
    expect(screen.queryByRole('button', { name: /Please configure/ })).not.toBeInTheDocument();
    expect(setSettingsOpen).not.toHaveBeenCalled();
  });

  it('opens skills settings when skills are empty and a sandbox is already configured', async () => {
    renderSelector({
      getCapabilities: async () => ({
        data: {
          sandbox: { enabled: true },
          skill: { enabled: false, reason: 'Skills are not available.' },
        },
      }),
      getSkills: async () => [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Please configure Skills in the settings/ }));

    expect(setSettingsOpen).toHaveBeenCalledWith(true, 'skills');
  });

  it('does not offer connector settings without a settings catalog', async () => {
    renderSelector({ getMcp: async () => [], catalog: null });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    expect(await screen.findByText('No connectors')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Please configure Connectors/ })).not.toBeInTheDocument();
  });

  it('does not offer connector settings when settings are disabled', async () => {
    renderSelector({
      getCapabilities: async () => ({
        data: {
          sandbox: { enabled: true },
          skill: { enabled: true },
          settings: { enabled: false },
        },
      }),
      getMcp: async () => [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    expect(await screen.findByText('No connectors')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Please configure Connectors/ })).not.toBeInTheDocument();
  });

  it('does not offer skills settings when the skills settings section is unavailable', async () => {
    renderSelector({ getSkills: async () => [], catalog: createMockCatalog() });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(await screen.findByText('No skills')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Please configure Skills/ })).not.toBeInTheDocument();
  });

  it('renders the sandbox toggle from the spec value', async () => {
    agentSpec = { ...agentSpec, skills: [], config: { sandbox: { enabled: true, fileDownloads: false } } };
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (1)' }));

    const sandboxSwitch = await screen.findByRole('switch', { name: 'Sandbox' });
    expect(sandboxSwitch).toHaveAttribute('aria-checked', 'true');
    expect(sandboxSwitch).not.toBeDisabled();
  });

  it('flips config.sandbox.enabled while keeping the rest of config intact', async () => {
    agentSpec = {
      ...agentSpec,
      skills: [],
      config: { sandbox: { enabled: true, fileDownloads: false }, memory: { recallEnabled: false } },
    };
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (1)' }));

    fireEvent.click(await screen.findByRole('switch', { name: 'Sandbox' }));

    expect(updateAgentSpec).toHaveBeenCalledWith({
      config: {
        sandbox: { enabled: false, fileDownloads: false },
        memory: { recallEnabled: false },
      },
    });
  });

  it('clears attached skills and notes it when turning the sandbox off', async () => {
    agentSpec = { ...agentSpec, config: { sandbox: { enabled: true, fileDownloads: true } } };
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    const sandboxSwitch = await screen.findByRole('switch', { name: 'Sandbox' });
    expect(screen.getByText(/Turning this off clears attached skills/)).toBeInTheDocument();
    fireEvent.click(sandboxSwitch);

    expect(updateAgentSpec).toHaveBeenCalledWith({
      skills: [],
      config: { sandbox: { enabled: false, fileDownloads: true } },
    });
  });

  it('disables the sandbox toggle when the sandbox capability is absent', async () => {
    renderSelector({
      getCapabilities: async () => ({
        data: {
          sandbox: { enabled: false },
          skill: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' },
        },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));

    const sandboxSwitch = await screen.findByRole('switch', { name: 'Sandbox' });
    expect(sandboxSwitch).toBeDisabled();
    expect(screen.getByText('The sandbox is not available on this server')).toBeInTheDocument();
  });

  it('does not offer sandbox settings when the sandbox settings section is unavailable', async () => {
    renderSelector({
      getCapabilities: async () => ({
        data: {
          sandbox: { enabled: false },
          skill: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' },
        },
      }),
      getSkills: async () => [],
      catalog: createMockCatalog({ skillCatalog }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add-ons (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(await screen.findByText('No skills')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Please configure a Sandbox/ })).not.toBeInTheDocument();
  });
});
