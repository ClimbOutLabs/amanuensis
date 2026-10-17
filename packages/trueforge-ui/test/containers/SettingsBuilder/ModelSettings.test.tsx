// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CustomProviderDraft } from '@/containers/SettingsBuilder/CustomModelProviderForm.js';
import ModelSettings from '@/containers/SettingsBuilder/ModelSettings.js';
import type { UiConfiguredModelProvider } from '@/plugins/trueforge-agent-server-adapter/catalogs/modelProviderCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { ModelProviderBase, UpdateModelProviderRequest } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const customProvider: ModelProviderBase<CustomProviderDraft['models'][number]> = {
  id: 'local-llama',
  type: 'custom',
  name: 'local-llama',
  baseUrl: 'http://localhost:11434/v1',
  models: [
    {
      id: 'llama3.1:70b',
      name: 'llama-3-1-70b',
      properties: {
        contextLength: 64000,
        maxOutputTokens: 2048,
        reasoningEfforts: ['high'],
      },
    },
  ],
};

const builtInProvider: ModelProviderBase = {
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  models: [{ id: 'gpt-4.1', name: 'gpt-4-1' }],
};

describe('ModelSettings removing the last model', () => {
  it('offers to remove the provider instead of sending an empty model list', async () => {
    const updateModelProvider = vi.fn();
    const deleteModelProvider = vi.fn(async () => undefined);
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [],
          listModelProviders: async () => [customProvider],
          createModelProvider: vi.fn(),
          updateModelProvider,
          deleteModelProvider,
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove llama-3-1-70b' }));
    expect(screen.getByRole('heading', { name: 'Remove llama-3-1-70b?' })).toBeInTheDocument();
    expect(screen.getByText(/Removing it removes the provider too/)).toBeInTheDocument();
    expect(updateModelProvider).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove provider' }));
    await waitFor(() => expect(deleteModelProvider).toHaveBeenCalledWith({ id: 'local-llama' }));
    expect(updateModelProvider).not.toHaveBeenCalled();
  });

  it('explains the limit when the host cannot remove providers', async () => {
    const updateModelProvider = vi.fn();
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [],
          listModelProviders: async () => [customProvider],
          createModelProvider: vi.fn(),
          updateModelProvider,
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove llama-3-1-70b' }));
    expect(screen.getByText(/Add another model first, or remove the provider/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove provider' })).not.toBeInTheDocument();
    expect(updateModelProvider).not.toHaveBeenCalled();
  });
});

describe('ModelSettings removing a provider directly', () => {
  it('the per-provider Remove button calls deleteModelProvider with the provider id', async () => {
    const updateModelProvider = vi.fn();
    const deleteModelProvider = vi.fn(async () => undefined);
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [],
          listModelProviders: async () => [customProvider],
          createModelProvider: vi.fn(),
          updateModelProvider,
          deleteModelProvider,
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleteModelProvider).toHaveBeenCalledWith({ id: 'local-llama' }));
    expect(updateModelProvider).not.toHaveBeenCalled();
  });

  it('hides the Remove button when the host cannot remove providers', async () => {
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [],
          listModelProviders: async () => [customProvider],
          createModelProvider: vi.fn(),
          updateModelProvider: vi.fn(),
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    await screen.findByRole('button', { name: 'Edit local-llama' });
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});

describe('ModelSettings custom provider editing', () => {
  it('opens the custom provider modal from Edit and updates the provider from the prefilled form', async () => {
    const updateModelProvider = vi.fn(async (request: UpdateModelProviderRequest) => ({
      ...customProvider,
      baseUrl: request.baseUrl,
      models: request.models,
    }));
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [
            {
              type: 'custom',
              name: 'custom',
              models: [],
              supportedReasoningEfforts: ['low', 'high'],
            },
          ],
          listModelProviders: async () => [customProvider, builtInProvider],
          createModelProvider: vi.fn(),
          updateModelProvider,
        },
      }),
    });

    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );

    const editButton = await screen.findByRole('button', { name: 'Edit local-llama' });
    expect(screen.getByRole('button', { name: 'Edit OpenAI' })).toBeInTheDocument();
    fireEvent.click(editButton);

    expect(screen.getByRole('heading', { name: 'Edit local-llama' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('local-llama')).toHaveValue('local-llama');
    expect(screen.getByPlaceholderText('local-llama')).toHaveAttribute('readonly');
    expect(screen.getByPlaceholderText('http://localhost:11434/v1')).toHaveValue('http://localhost:11434/v1');
    expect(screen.getByPlaceholderText('llama3.1:70b')).toHaveValue('llama3.1:70b');
    expect(screen.getByPlaceholderText('128000')).toHaveValue(64000);
    expect(screen.getByPlaceholderText('4096')).toHaveValue(2048);

    fireEvent.change(screen.getByPlaceholderText('http://localhost:11434/v1'), {
      target: { value: 'http://localhost:11434/v2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateModelProvider).toHaveBeenCalledTimes(1));
    expect(updateModelProvider).toHaveBeenCalledWith({
      id: 'local-llama',
      type: 'custom',
      name: 'local-llama',
      baseUrl: 'http://localhost:11434/v2',
      apiKey: '',
      models: customProvider.models,
    });
  });
});

describe('ModelSettings environment-managed provider', () => {
  const managedProvider: UiConfiguredModelProvider = {
    id: 'tokenfactory',
    type: 'tokenfactory',
    name: 'tokenfactory',
    envManaged: true,
    models: [{ id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b' }],
  };

  function renderSettings(providers: UiConfiguredModelProvider[]) {
    const server = createMockAgentUIServer({
      catalog: createMockCatalog({
        modelCatalog: {
          getModelProviderCatalog: async () => [
            {
              type: 'tokenfactory',
              name: 'tokenfactory',
              models: [
                { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron-3-super-120b-a12b' },
                { id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b' },
              ],
            },
          ],
          listModelProviders: async () => providers,
          createModelProvider: vi.fn(),
          updateModelProvider: vi.fn(),
          deleteModelProvider: vi.fn(async () => undefined),
        },
      }),
    });
    render(
      <ServerProvider server={server}>
        <ModelSettings />
      </ServerProvider>,
    );
  }

  it('shows it connected and read-only, with no way to change the key or models', async () => {
    renderSettings([managedProvider]);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Managed by server environment')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit tokenfactory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove nemotron-3-super-120b-a12b' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Available to add/)).not.toBeInTheDocument();
  });

  it('keeps Edit and Remove for the same provider when the server does not manage it', async () => {
    renderSettings([{ ...managedProvider, envManaged: false }]);

    expect(await screen.findByRole('button', { name: 'Edit tokenfactory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByText('Managed by server environment')).not.toBeInTheDocument();
  });
});
