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

function renderPage() {
  return render(
    <ServerProvider server={createMockAgentUIServer({ getModels: async () => models })}>
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
  });

  it('names the four roles that have a real model call behind them', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Roles and Personas' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Main chat model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Coding / subagent model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Compaction model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summarization model' })).toBeInTheDocument();
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
