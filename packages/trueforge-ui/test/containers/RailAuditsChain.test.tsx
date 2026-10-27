// @vitest-environment jsdom
import { useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAgentUIServer, createMockCatalog } from '../server/mockServer.js';

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => vi.fn(),
  trueFoundryAttachmentAdapter: {},
  useTrueFoundryAgentRuntime: () =>
    useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      isRunning: false,
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => {},
    }),
  useTrueFoundryCancel: () => vi.fn(),
  useTrueFoundryToolResponses: () => ({ pending: [] }),
  useTrueFoundryApprovals: () => ({ pending: [] }),
  useTrueFoundryRespondToToolApproval: () => vi.fn(),
  useTrueFoundryMcpAuth: () => ({ pending: [], connect: vi.fn(), continue: vi.fn() }),
  useTrueFoundryHistoryPagination: () => ({
    isLoadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
  }),
  useTrueFoundryAgentSpec: () => ({
    agentSpec: { model: { name: 'openai-main/gpt-4.1' } },
  }),
  useTrueFoundryFlushAgentSpec: () => async () => {},
  useTrueFoundryAdoptAgentSpec: () => vi.fn(),
  useTrueFoundryUpdateAgentSpec: () => vi.fn(),
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => <div data-testid="thinking-orb" />,
}));

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import { TrueForgeUI } from '@/containers/TrueForgeUI.js';
import { useShellMode, type SettingsOpenRequest } from '@/server/ShellModeContext.js';
import type { AgentBuilderCapabilitiesResponse, AgentUIServer } from '@/server/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

/** Stands in for a layout: it reads the shell state the real layouts open Settings from. */
function SettingsStateLayout() {
  const shell = useShellMode();
  return <div data-testid="settings-state">{`${String(shell.settingsOpen)} / ${shell.settingsSection}`}</div>;
}

/**
 * A faithful stand-in for the frontend host (AmanShell in packages/frontend/src/App.tsx):
 * the rail sits next to the chat surface, the host holds the settings request and the
 * chrome report in state, and the rail is handed its Audits link only while the shell
 * reports Settings chrome enabled. If any prop in that chain is dropped, these tests fail.
 */
function RailHost({ server }: { server: AgentUIServer }) {
  const [settingsOpenRequest, setSettingsOpenRequest] = useState<SettingsOpenRequest | undefined>(undefined);
  const [settingsChromeEnabled, setSettingsChromeEnabled] = useState(true);
  const openAudits = () => {
    setSettingsOpenRequest(previous => ({ section: 'audit', nonce: (previous?.nonce ?? 0) + 1 }));
  };
  return (
    <>
      <TrueForgeUI
        server={server}
        layout={SettingsStateLayout}
        {...(settingsOpenRequest ? { settingsOpenRequest } : {})}
        onSettingsChromeEnabledChange={setSettingsChromeEnabled}
      />
      <AmanRuntimeRail
        auditFeed={<p>Recent actions body</p>}
        {...(settingsChromeEnabled ? { onOpenAudits: openAudits } : {})}
      />
    </>
  );
}

function renderHost(server: AgentUIServer) {
  return render(
    <RuntimeHarness messages={[]}>
      <RailHost server={server} />
    </RuntimeHarness>,
  );
}

describe('rail Audits link wired through the host to the shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The rail probes connectivity on mount; keep the probe in flight so no test sees a
    // status flip after its assertions.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  it('opens Settings at the audit section when the link is clicked', async () => {
    const server = createMockAgentUIServer({ catalog: createMockCatalog() });
    renderHost(server);

    const auditsLink = await screen.findByRole('button', { name: 'Audits' });
    fireEvent.click(auditsLink);

    await waitFor(() => {
      expect(screen.getByTestId('settings-state')).toHaveTextContent('true / audit');
    });
  });

  it('hides the link once the server says Settings is disabled', async () => {
    let resolveCapabilities: (value: AgentBuilderCapabilitiesResponse) => void = () => {};
    const capabilitiesPromise = new Promise<AgentBuilderCapabilitiesResponse>(resolve => {
      resolveCapabilities = resolve;
    });
    const server = createMockAgentUIServer({
      catalog: createMockCatalog(),
      getCapabilities: () => capabilitiesPromise,
    });
    renderHost(server);

    // While capabilities are still loading the link shows, exactly like the Settings
    // button inside the shell, which also shows until capabilities say otherwise.
    expect(await screen.findByRole('button', { name: 'Audits' })).toBeInTheDocument();

    act(() => {
      resolveCapabilities({
        data: {
          sandbox: { enabled: true },
          skill: { enabled: true },
          settings: { enabled: false },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Audits' })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-state')).toHaveTextContent('false / models');
  });

  it('hides the link when the server has no settings catalog', async () => {
    const server = createMockAgentUIServer();
    renderHost(server);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Audits' })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-state')).toHaveTextContent('false / models');
  });
});
