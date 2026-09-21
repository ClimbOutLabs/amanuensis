// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftAuxiliaryModelSelector, type AuxiliaryModels } from '@/atoms/draft/DraftAuxiliaryModelSelector.js';
import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec, AgentUIServer, ModelSelection } from '@/server/types.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

let agentSpec: (AgentSpec & { auxiliaryModels?: AuxiliaryModels }) | undefined;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

const models: ModelSelection[] = [
  {
    id: 'gpt-4.1',
    name: 'openai/gpt-4.1',
    provider: { name: 'OpenAI', logo: 'https://assets.example/openai.svg' },
    properties: {},
  },
  {
    id: 'claude-3.7-sonnet',
    name: 'anthropic/claude-3.7-sonnet',
    provider: { name: 'Anthropic' },
    properties: {},
  },
];

function renderSelector(
  role: 'compaction' | 'delegation',
  roleLabel: string,
  serverOverrides: Partial<AgentUIServer> = { getModels: async () => models },
) {
  const server = createMockAgentUIServer(serverOverrides);
  return render(
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <DraftAuxiliaryModelSelector role={role} roleLabel={roleLabel} />
      </DraftCatalogProvider>
    </ServerProvider>,
  );
}

describe('DraftAuxiliaryModelSelector', () => {
  beforeEach(() => {
    updateAgentSpec.mockReset();
  });

  it('displays as inheriting and names the current main model when nothing is set', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    await waitFor(() => expect(trigger).toHaveTextContent('Default'));
    expect(trigger).toHaveTextContent('gpt-4.1');
  });

  it('selecting a model for one role writes only that role and leaves the other untouched', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: { delegation: { name: 'anthropic/claude-3.7-sonnet' } },
    };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /gpt-4.1/i }));

    expect(updateAgentSpec).toHaveBeenCalledWith({
      auxiliaryModels: {
        delegation: { name: 'anthropic/claude-3.7-sonnet' },
        compaction: { name: 'openai/gpt-4.1' },
      },
    });
  });

  it('clears a role by removing its key, not by freezing the current main model into it', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: {
        compaction: { name: 'anthropic/claude-3.7-sonnet' },
        delegation: { name: 'openai/gpt-4.1' },
      },
    };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    await waitFor(() => expect(trigger).toHaveTextContent('claude-3.7-sonnet'));
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('option', { name: /^Default/ }));

    expect(updateAgentSpec).toHaveBeenCalledWith({
      auxiliaryModels: { delegation: { name: 'openai/gpt-4.1' } },
    });
    const [call] = updateAgentSpec.mock.calls[0] as [{ auxiliaryModels?: AuxiliaryModels }];
    expect(call.auxiliaryModels).not.toHaveProperty('compaction');
  });

  it('renders a role naming a model missing from the catalog as unavailable, not as Default', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: { compaction: { name: 'mystery/unknown-model' } },
    };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    await waitFor(() => expect(trigger).toHaveTextContent('unknown-model'));
    expect(trigger).not.toHaveTextContent('Default');
    expect(screen.getByText('Not in the current model catalog')).toBeInTheDocument();
  });

  it('gives every catalog option an accessible name of "provider model"', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'OpenAI gpt-4.1' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Anthropic claude-3.7-sonnet' })).toBeInTheDocument();
  });

  it('titles each catalog option with the full "provider / model" text', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    expect(screen.getByTitle('OpenAI / gpt-4.1')).toBeInTheDocument();
    expect(screen.getByTitle('Anthropic / claude-3.7-sonnet')).toBeInTheDocument();
  });

  it('labels the search box so it has an accessible name', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    expect(screen.getByRole('searchbox', { name: 'Search models' })).toBeInTheDocument();
  });

  it('splits the trigger into a provider caption and a full model name, and titles the pair', async () => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1' },
      auxiliaryModels: { compaction: { name: 'anthropic/claude-3.7-sonnet' } },
    };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    await waitFor(() => expect(trigger).toHaveTextContent('claude-3.7-sonnet'));

    const caption = within(trigger).getByText('Anthropic');
    const name = within(trigger).getByText('claude-3.7-sonnet');
    expect(caption).toBeInTheDocument();
    expect(name).toBeInTheDocument();
    expect(name.closest('[title]')).toHaveAttribute('title', 'Anthropic / claude-3.7-sonnet');
  });

  it('renders the open menu through a portal so it escapes the settings pane scroll container', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    const { container } = renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    const listbox = await screen.findByRole('listbox');
    expect(container.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });

  it('gives the listbox id to exactly one element, the listbox itself, not the portal wrapper around it', async () => {
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    renderSelector('compaction', 'Compaction');

    const trigger = await screen.findByTitle('Select Compaction model');
    fireEvent.click(trigger);

    const listbox = await screen.findByRole('listbox');
    const controlledId = trigger.getAttribute('aria-controls');
    if (controlledId == null) throw new Error('trigger has no aria-controls');
    expect(listbox).toHaveAttribute('id', controlledId);

    const matches = document.querySelectorAll(`#${CSS.escape(controlledId)}`);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(listbox);
  });
});
