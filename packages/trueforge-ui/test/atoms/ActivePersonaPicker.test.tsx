// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useThreadIsRunning = vi.fn(() => false);
const useAuiState = vi.fn();

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@/assistant-ui.js', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

import { ActivePersonaIndicator } from '@/atoms/ActivePersonaIndicator.js';
import { PersonaProvider, type Persona, type PersonaApi, type SessionPersona } from '@/components/PersonaContext.js';

const ZARA: Persona = {
  id: 'p-zara',
  display_name: 'Zara',
  aliases: ['Z'],
  instructions: 'Answer as a careful archivist.',
  model_name: 'anthropic/haiku',
};

const NOVA: Persona = {
  id: 'p-nova',
  display_name: 'Nova',
  aliases: [],
  instructions: 'Answer as a terse engineer.',
  model_name: 'openai/gpt-4.1',
};

const ZARA_ACTIVE: SessionPersona = {
  persona_id: 'p-zara',
  persona_name: 'Zara',
  model_name: 'anthropic/haiku',
  source: 'invocation',
  turn_id: 't-1',
};

const DEFAULT_SPEAKER: SessionPersona = {
  persona_id: null,
  persona_name: null,
  model_name: null,
  source: 'default',
  turn_id: null,
};

async function unavailable(): Promise<never> {
  throw new Error('Unexpected persona API call');
}

function renderPicker(overrides: Partial<PersonaApi>, personas: Persona[] = [ZARA, NOVA]) {
  const api: PersonaApi = {
    listPersonas: async () => personas,
    createPersona: unavailable,
    updatePersona: unavailable,
    deletePersona: unavailable,
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
    ...overrides,
  };
  render(
    <PersonaProvider api={api}>
      <ActivePersonaIndicator />
    </PersonaProvider>,
  );
}

async function openMenu() {
  const trigger = await screen.findByRole('button', { name: 'Choose who answers this chat' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return trigger;
}

describe('ActivePersonaPicker', () => {
  beforeEach(() => {
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' } }),
    );
  });

  it('renders nothing when the host wired no persona API at all', () => {
    render(<ActivePersonaIndicator />);
    expect(screen.queryByTestId('active-persona-picker')).not.toBeInTheDocument();
  });

  it('renders nothing when the host wired no personas yet', async () => {
    renderPicker({}, []);

    await waitFor(() => {
      expect(screen.queryByTestId('active-persona-picker')).not.toBeInTheDocument();
    });
  });

  it('offers the picker even while the default assistant answers', async () => {
    renderPicker({});

    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Default assistant' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Zara' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Nova' })).toBeInTheDocument();
    // No active speaker, so nothing is rendered as the chip.
    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
  });

  it('lists personas and hands the chat to the chosen one', async () => {
    let serverPersona: SessionPersona | null = null;
    const setSessionPersona = vi.fn(async (): Promise<SessionPersona> => {
      serverPersona = ZARA_ACTIVE;
      return ZARA_ACTIVE;
    });
    const getSessionPersona = vi.fn(async () => serverPersona);
    renderPicker({ getSessionPersona, setSessionPersona });

    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zara' }));

    await waitFor(() => {
      expect(setSessionPersona).toHaveBeenCalledWith('sess-1', 'p-zara');
    });
    // The menu closes on selection and the chip reflects the new speaker.
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
  });

  it('clears back to the default assistant from the menu', async () => {
    let serverPersona: SessionPersona | null = ZARA_ACTIVE;
    const setSessionPersona = vi.fn(async (): Promise<SessionPersona> => {
      serverPersona = DEFAULT_SPEAKER;
      return DEFAULT_SPEAKER;
    });
    const getSessionPersona = vi.fn(async () => serverPersona);
    renderPicker({ getSessionPersona, setSessionPersona });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');

    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Default assistant' }));

    await waitFor(() => {
      expect(setSessionPersona).toHaveBeenCalledWith('sess-1', null);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
    });
  });

  it('dismisses the menu with Escape and returns focus to the trigger', async () => {
    renderPicker({});

    const trigger = await openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  it('marks the currently active persona in the menu', async () => {
    renderPicker({ getSessionPersona: async () => ZARA_ACTIVE });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    await openMenu();

    const zaraItem = screen.getByRole('menuitem', { name: 'Zara' });
    const novaItem = screen.getByRole('menuitem', { name: 'Nova' });
    expect(zaraItem.querySelector('svg')).toBeInTheDocument();
    expect(novaItem.querySelector('svg')).not.toBeInTheDocument();
  });
});
