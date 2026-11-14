// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliaryModels } from '@/atoms/draft/DraftAuxiliaryModelSelector.js';
import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import ModelRoleSettings from '@/containers/SettingsBuilder/ModelRoleSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec, ModelSelection } from '@/server/types.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

let agentSpec: (AgentSpec & { auxiliaryModels?: AuxiliaryModels }) | undefined;
let specError: unknown | null;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec, specError }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

const models: ModelSelection[] = [
  { id: 'gpt-4.1', name: 'openai/gpt-4.1', provider: { name: 'OpenAI' }, properties: {} },
  { id: 'haiku', name: 'anthropic/haiku', provider: { name: 'Anthropic' }, properties: {} },
];

let helperModel: string | null;
const helperWrites: Array<string | null> = [];
const QUIET_TIDY = {
  status: 'idle' as const,
  movedToEarlier: 0,
  notesAsked: 0,
  notesSorted: 0,
  pairsListed: 0,
  sorting: 'off' as const,
  modelMissing: false,
  unsortedReasons: [],
};

/** The app's own server keeps the background model; a server without this port does not offer the role. */
function nightlyPort() {
  const stored = () => ({
    enabled: false,
    overridden: false,
    defaultEnabled: false,
    hour: 0,
    modelWaitMinutes: 10,
    helperModel,
  });
  return {
    getMemoryNightly: async () => stored(),
    setMemoryNightly: async (change: { helperModel?: string | null }) => {
      if (change.helperModel !== undefined) {
        helperWrites.push(change.helperModel);
        helperModel = change.helperModel;
      }
      return stored();
    },
    tidyMemoryNow: async () => QUIET_TIDY,
    getMemoryTidyState: async () => QUIET_TIDY,
  };
}

function renderPage({ ownServer = true }: { ownServer?: boolean } = {}) {
  const server = {
    ...createMockAgentUIServer({ getModels: async () => models }),
    ...(ownServer ? { memoryNightly: nightlyPort() } : {}),
  };
  return render(
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <ModelRoleSettings />
      </DraftCatalogProvider>
    </ServerProvider>,
  );
}

describe('ModelRoleSettings', () => {
  beforeEach(() => {
    updateAgentSpec.mockReset();
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    specError = null;
    helperModel = null;
    helperWrites.length = 0;
  });

  it('names the four roles that have a real model call behind them', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Roles and Personas' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Main chat model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Coding / subagent model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Compaction model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Background model' })).toBeInTheDocument();
  });

  it('keeps the background model on the server, not in the chat being set up', async () => {
    renderPage();

    fireEvent.click(await screen.findByTitle('Select Background model'));
    fireEvent.click(await screen.findByRole('option', { name: /haiku/ }));

    await waitFor(() => expect(helperWrites).toEqual(['anthropic/haiku']));
    expect(updateAgentSpec).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTitle('Select Background model')).toHaveTextContent('haiku'));
  });

  it('goes back to the main model when Default is chosen for the helper', async () => {
    helperModel = 'anthropic/haiku';
    renderPage();

    await waitFor(() => expect(screen.getByTitle('Select Background model')).toHaveTextContent('haiku'));
    fireEvent.click(screen.getByTitle('Select Background model'));
    fireEvent.click(await screen.findByRole('option', { name: /^Default/ }));

    await waitFor(() => expect(helperWrites).toEqual([null]));
  });

  it('says so when the stored background model is no longer listed', async () => {
    helperModel = 'mystery/gone-model';
    renderPage();

    const row = (await screen.findByRole('heading', { name: 'Background model' })).closest('article');
    expect(row).not.toBeNull();
    await waitFor(() =>
      expect(within(row ?? document.body).getByText('Not in the current model catalog')).toBeInTheDocument(),
    );
  });

  it('offers no background model on a server that does not keep one', async () => {
    renderPage({ ownServer: false });

    expect(await screen.findByRole('heading', { name: 'Compaction model' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Background model' })).not.toBeInTheDocument();
  });

  it('shows no sub-tab strip when the host has no personas', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Roles and Personas' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Roles and Personas sections' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Main chat model' })).toBeInTheDocument();
  });

  it('does not claim a small Nemotron model handles memory summaries or library checks', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'Roles and Personas' });
    expect(screen.queryByText(/nemotron/i)).not.toBeInTheDocument();
  });

  it('explains why bounded background checks reuse the main model', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'Roles and Personas' });
    expect(screen.getByText(/background checks.*reuse the main chat model/i)).toBeInTheDocument();
    expect(screen.getByText(/they do not need their own role/i)).toBeInTheDocument();
  });

  it('shows shared draft-save failures at the settings-page level', async () => {
    specError = new Error('Connector update rejected');
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to save agent settings: Connector update rejected',
    );
  });

  it('writes only the role that was changed', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: { compaction: { name: 'anthropic/haiku' } },
    };
    renderPage();

    const trigger = await screen.findByTitle('Select Coding / subagent model');
    fireEvent.click(trigger);
    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /haiku/i }));

    await waitFor(() => {
      expect(updateAgentSpec).toHaveBeenCalledWith({
        auxiliaryModels: { compaction: { name: 'anthropic/haiku' }, delegation: { name: 'anthropic/haiku' } },
      });
    });
  });

  it('keeps an assigned model that has left the catalog visibly unavailable', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: { compaction: { name: 'mystery/gone-model' } },
    };
    renderPage();

    const trigger = await screen.findByTitle('Select Compaction model');
    await waitFor(() => expect(trigger).toHaveTextContent('gone-model'));
    expect(trigger).not.toHaveTextContent('Default');
    expect(screen.getByText('Not in the current model catalog')).toBeInTheDocument();
  });
});
