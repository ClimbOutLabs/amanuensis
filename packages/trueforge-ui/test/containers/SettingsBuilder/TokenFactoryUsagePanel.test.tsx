// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ModelSettings from '@/containers/SettingsBuilder/ModelSettings.js';
import { TokenFactoryUsagePanel } from '@/containers/SettingsBuilder/TokenFactoryUsagePanel.js';
import type { TokenFactoryUsage } from '@/plugins/trueforge-agent-server-adapter/catalogs/tokenFactoryUsageCatalog.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { ModelProviderBase } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

const USAGE: TokenFactoryUsage = {
  usageDate: '2026-10-15',
  capTokens: 2_500_000,
  usedTokens: 1_812_300,
  remainingTokens: 687_700,
  costUsd: 0.62,
  models: [
    {
      modelId: 'nvidia/nemotron-3-super-120b-a12b',
      displayName: 'Nemotron 3 Super',
      inputTokens: 1_200_000,
      outputTokens: 300_000,
      calls: 41,
      costUsd: 0.63,
    },
    {
      modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      displayName: 'Nemotron 3 Nano',
      inputTokens: 300_000,
      outputTokens: 12_300,
      calls: 88,
      costUsd: 0.0209,
    },
  ],
};

/** The runtime-shaped mock server with the usage port beside it, as the adapter attaches it. */
function serverWithUsage(getTokenFactoryUsage: () => Promise<TokenFactoryUsage>) {
  return { ...createMockAgentUIServer(), tokenFactoryUsage: { getTokenFactoryUsage } };
}

function renderPanel(server: ReturnType<typeof createMockAgentUIServer>, providerConfigured = true) {
  return render(
    <ServerProvider server={server}>
      <TokenFactoryUsagePanel providerConfigured={providerConfigured} />
    </ServerProvider>,
  );
}

describe('TokenFactoryUsagePanel', () => {
  it('shows tokens and cost per model, the total, and the cap remaining', async () => {
    renderPanel(serverWithUsage(async () => USAGE));

    const rows = await screen.findAllByTestId('token-factory-model-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Nemotron 3 Super41' + '1,200,000' + '300,000' + '$0.6300');
    expect(rows[1]).toHaveTextContent('Nemotron 3 Nano88' + '300,000' + '12,300' + '$0.0209');
    expect(screen.getByTestId('token-factory-cap')).toHaveTextContent('687,700 of 2,500,000 tokens remaining');
    expect(screen.getByRole('progressbar', { name: 'Daily token cap used' })).toHaveAttribute('aria-valuenow', '72');
    expect(screen.getByText('1,812,300 tokens')).toBeInTheDocument();
    expect(screen.getByText('UTC day 2026-10-15. Counters reset at midnight UTC.')).toBeInTheDocument();
  });

  it('says there is no cap when none is set', async () => {
    renderPanel(serverWithUsage(async () => ({ ...USAGE, capTokens: null, remainingTokens: null })));

    expect(await screen.findByTestId('token-factory-cap')).toHaveTextContent(
      'No daily cap. 1,812,300 tokens used today.',
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows a model without a known price as no price, not as free', async () => {
    renderPanel(
      serverWithUsage(async () => ({
        ...USAGE,
        costUsd: null,
        models: USAGE.models.map(model => ({ ...model, costUsd: null })),
      })),
    );

    expect((await screen.findAllByText('no price')).length).toBe(3);
  });

  it('explains an empty day', async () => {
    renderPanel(
      serverWithUsage(async () => ({ ...USAGE, usedTokens: 0, remainingTokens: 2_500_000, costUsd: 0, models: [] })),
    );

    expect(await screen.findByText('No Token Factory calls yet today.')).toBeInTheDocument();
  });

  it('reads again when refreshed', async () => {
    const getTokenFactoryUsage = vi.fn(async () => USAGE);
    renderPanel(serverWithUsage(getTokenFactoryUsage));
    await screen.findAllByTestId('token-factory-model-row');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(getTokenFactoryUsage).toHaveBeenCalledTimes(2));
  });

  it('shows the failure instead of an empty day when the read fails', async () => {
    renderPanel(
      serverWithUsage(async () => {
        throw new Error('Admin access required');
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
    expect(screen.queryByTestId('token-factory-model-row')).not.toBeInTheDocument();
  });

  it('renders nothing on a server without the usage port', () => {
    renderPanel(createMockAgentUIServer());

    expect(screen.queryByTestId('token-factory-usage')).not.toBeInTheDocument();
  });

  it('renders nothing when Token Factory is not connected and nothing was counted', async () => {
    const getTokenFactoryUsage = vi.fn(async () => ({
      ...USAGE,
      capTokens: null,
      remainingTokens: null,
      usedTokens: 0,
      costUsd: 0,
      models: [],
    }));
    renderPanel(serverWithUsage(getTokenFactoryUsage), false);

    await waitFor(() => expect(getTokenFactoryUsage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('token-factory-usage')).not.toBeInTheDocument());
  });
});

describe('ModelSettings', () => {
  it('shows the daily Token Factory view on the Models page when the provider is connected', async () => {
    const tokenFactory: ModelProviderBase = {
      id: 'tokenfactory',
      type: 'tokenfactory',
      name: 'tokenfactory',
      models: [{ id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b' }],
    };
    const base = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [],
          listModelProviders: async () => [tokenFactory],
          createModelProvider: vi.fn(),
          updateModelProvider: vi.fn(),
          deleteModelProvider: vi.fn(),
        },
      }),
    });
    const server = { ...base, tokenFactoryUsage: { getTokenFactoryUsage: async () => USAGE } };

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    const panel = await screen.findByTestId('token-factory-usage');
    expect(within(panel).getByText('Token Factory today')).toBeInTheDocument();
    expect(await within(panel).findAllByTestId('token-factory-model-row')).toHaveLength(2);
  });

  describe('offline mode', () => {
    function renderWithOffline({ offline }: { offline: boolean }) {
      const settings: SentinelUserSettings = {
        offline_mode: offline,
        tier2_auto_allow: [],
        search_without_asking: true,
      };
      const api: SentinelApi = {
        listAuditEntries: vi.fn(async () => []),
        getUserSettings: vi.fn(async () => settings),
        updateUserSettings: vi.fn(async () => settings),
        listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
      };
      return render(
        <SentinelApiProvider api={api}>
          <ServerProvider server={serverWithUsage(async () => USAGE)}>
            <TokenFactoryUsagePanel providerConfigured />
          </ServerProvider>
        </SentinelApiProvider>,
      );
    }

    it('says plainly that answers still use the internet while offline mode is on', async () => {
      renderWithOffline({ offline: true });

      const notice = await screen.findByTestId('token-factory-offline-notice');
      expect(notice).toHaveTextContent('Offline mode is on.');
      expect(notice).toHaveTextContent('Token Factory is online');
    });

    it('shows no notice while offline mode is off', async () => {
      renderWithOffline({ offline: false });

      await screen.findAllByTestId('token-factory-model-row');
      expect(screen.queryByTestId('token-factory-offline-notice')).toBeNull();
    });
  });
});
