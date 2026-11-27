// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { PersonaProvider, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import { SpokenReplyProvider } from '@/components/SpokenReplyContext.js';
import PersonaSettings from '@/containers/SettingsBuilder/PersonaSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { ModelSelection } from '@/server/types.js';
import type { ServerVoiceApi } from '@/utils/spokenReplyPlayer.js';
import { personaApiStubs } from '../../personaApiStubs.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const models: ModelSelection[] = [
  { id: 'gpt-4.1', name: 'openai/gpt-4.1', provider: { name: 'OpenAI' }, properties: {} },
  { id: 'haiku', name: 'anthropic/haiku', provider: { name: 'Anthropic' }, properties: {} },
];

const ZARA: Persona = {
  id: 'p-zara',
  display_name: 'Zara',
  aliases: ['Z'],
  instructions: 'Answer as a careful archivist.',
  model_name: 'anthropic/haiku',
  voice: null,
};

async function unavailable(): Promise<never> {
  throw new Error('Unexpected persona API call');
}

function renderSettings(
  api: Partial<PersonaApi> & Pick<PersonaApi, 'listPersonas'>,
  getModels: () => Promise<ModelSelection[]> = async () => models,
  serverVoice?: ServerVoiceApi,
) {
  const full: PersonaApi = {
    ...personaApiStubs,
    createPersona: unavailable,
    updatePersona: unavailable,
    deletePersona: unavailable,
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
    ...api,
  };
  const settings = (
    <ServerProvider server={createMockAgentUIServer({ getModels })}>
      <DraftCatalogProvider>
        <PersonaProvider api={full}>
          <PersonaSettings />
        </PersonaProvider>
      </DraftCatalogProvider>
    </ServerProvider>
  );
  return render(
    serverVoice === undefined ? (
      settings
    ) : (
      <SpokenReplyProvider serverVoice={serverVoice}>{settings}</SpokenReplyProvider>
    ),
  );
}

function voiceServer(): ServerVoiceApi & { voices: string[] } {
  const voices: string[] = [];
  return {
    voices,
    speak: ({ voice }) => {
      voices.push(voice);
      return Promise.reject(new Error('no audio in tests'));
    },
  };
}

describe('PersonaSettings', () => {
  it('gives a persona its own voice, plays a sample of it, and saves it', async () => {
    const updatePersona = vi.fn(async () => ({ ...ZARA, voice: 'af_bella' }));
    const server = voiceServer();
    renderSettings({ listPersonas: async () => [ZARA], updatePersona }, undefined, server);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Zara' }));
    const picker = screen.getByLabelText('Voice');
    expect(picker).toHaveValue('');
    fireEvent.change(picker, { target: { value: 'af_bella' } });
    await waitFor(() => expect(server.voices).toEqual(['af_bella']));
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));

    await waitFor(() => {
      expect(updatePersona).toHaveBeenCalledWith('p-zara', {
        display_name: 'Zara',
        aliases: ['Z'],
        instructions: 'Answer as a careful archivist.',
        model_name: 'anthropic/haiku',
        voice: 'af_bella',
      });
    });
  });

  it('shows a persona’s own voice, and lets it go back to the person’s voice setting', async () => {
    const updatePersona = vi.fn(async () => ZARA);
    renderSettings(
      { listPersonas: async () => [{ ...ZARA, voice: 'am_michael' }], updatePersona },
      undefined,
      voiceServer(),
    );

    expect(await screen.findByText(/Voice: Michael, a man/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Zara' }));
    expect(screen.getByLabelText('Voice')).toHaveValue('am_michael');
    fireEvent.change(screen.getByLabelText('Voice'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));

    await waitFor(() => {
      expect(updatePersona).toHaveBeenCalledWith('p-zara', expect.objectContaining({ voice: null }));
    });
  });

  it('hides the voice picker without the computer’s voice, and keeps the voice a persona already has', async () => {
    const updatePersona = vi.fn(async () => ZARA);
    renderSettings({ listPersonas: async () => [{ ...ZARA, voice: 'af_bella' }], updatePersona });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Zara' }));
    expect(screen.queryByLabelText('Voice')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));

    await waitFor(() => {
      expect(updatePersona).toHaveBeenCalledWith('p-zara', expect.objectContaining({ voice: 'af_bella' }));
    });
  });

  it('shows a persona with its aliases and its assigned model, not hidden in prompt text', async () => {
    renderSettings({ listPersonas: async () => [ZARA] });

    expect(await screen.findByRole('heading', { name: 'Zara' })).toBeInTheDocument();
    expect(screen.getByText(/Also: Z/)).toBeInTheDocument();
    expect(screen.getByText(/haiku/)).toBeInTheDocument();
  });

  it('creates a persona from the typed name, aliases, role, and model', async () => {
    const createPersona = vi.fn(async () => ZARA);
    renderSettings({ listPersonas: async () => [], createPersona });

    fireEvent.click(await screen.findByRole('button', { name: /Add persona/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Zara' } });
    fireEvent.change(screen.getByLabelText('Also answers to'), { target: { value: ' Z , Zara Quinn ' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Answer as a careful archivist.' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'anthropic/haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create persona' }));

    await waitFor(() => {
      expect(createPersona).toHaveBeenCalledWith({
        display_name: 'Zara',
        aliases: ['Z', 'Zara Quinn'],
        instructions: 'Answer as a careful archivist.',
        model_name: 'anthropic/haiku',
        voice: null,
      });
    });
  });

  it('selects the first model when the catalog loads after opening the add form', async () => {
    let resolveModels!: (value: ModelSelection[]) => void;
    const modelsReady = new Promise<ModelSelection[]>(resolve => {
      resolveModels = resolve;
    });
    const createPersona = vi.fn(async () => ZARA);
    renderSettings({ listPersonas: async () => [], createPersona }, () => modelsReady);

    fireEvent.click(await screen.findByRole('button', { name: /Add persona/ }));
    expect(screen.getByLabelText('Model')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create persona' })).toBeDisabled();

    resolveModels(models);
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('openai/gpt-4.1'));
    expect(screen.getByRole('button', { name: 'Create persona' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Zara' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create persona' }));
    await waitFor(() => {
      expect(createPersona).toHaveBeenCalledWith({
        display_name: 'Zara',
        aliases: [],
        instructions: '',
        model_name: 'openai/gpt-4.1',
        voice: null,
      });
    });
  });

  it('surfaces a rejected alias collision instead of silently keeping the old value', async () => {
    const createPersona = vi.fn(async () => {
      throw new Error('Persona name or alias already in use: z');
    });
    renderSettings({ listPersonas: async () => [ZARA], createPersona });

    fireEvent.click(await screen.findByRole('button', { name: /Add persona/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova' } });
    fireEvent.change(screen.getByLabelText('Also answers to'), { target: { value: 'Z' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Answer briefly.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create persona' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already in use: z');
    // The form stays open with what was typed, so the collision can be corrected.
    expect(screen.getByLabelText('Name')).toHaveValue('Nova');
  });

  it('edits a persona in place and can delete it', async () => {
    const updatePersona = vi.fn(async () => ZARA);
    const deletePersona = vi.fn(async () => undefined);
    renderSettings({ listPersonas: async () => [ZARA], updatePersona, deletePersona });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Zara' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Answer briefly.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));

    await waitFor(() => {
      expect(updatePersona).toHaveBeenCalledWith('p-zara', {
        display_name: 'Zara',
        aliases: ['Z'],
        instructions: 'Answer briefly.',
        model_name: 'anthropic/haiku',
        voice: null,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Zara' }));
    await waitFor(() => {
      expect(deletePersona).toHaveBeenCalledWith('p-zara');
    });
  });

  it('marks a persona whose model has left the catalog as unavailable', async () => {
    renderSettings({ listPersonas: async () => [{ ...ZARA, model_name: 'mystery/gone-model' }] });

    expect(await screen.findByText(/not in the current model catalog/i)).toBeInTheDocument();
  });
});
