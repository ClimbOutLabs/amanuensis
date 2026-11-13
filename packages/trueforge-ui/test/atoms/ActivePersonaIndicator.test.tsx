// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { PersonaProvider, type PersonaApi, type SessionPersona } from '@/components/PersonaContext.js';
import { applyHeldPersona, holdPersonaForNewChat } from '@/personaMutationGate.js';
import { personaKnowledgeApiStubs } from '../personaApiStubs.js';

const ZARA: SessionPersona = {
  persona_id: 'p-zara',
  persona_name: 'Zara',
  model_name: 'anthropic/haiku',
  source: 'invocation',
  turn_id: 't-1',
};

const NOVA: SessionPersona = {
  persona_id: 'p-nova',
  persona_name: 'Nova',
  model_name: 'openai/gpt-4.1',
  source: 'invocation',
  turn_id: 't-2',
};

const DEFAULT_SPEAKER: SessionPersona = {
  persona_id: null,
  persona_name: null,
  model_name: null,
  source: 'default',
  turn_id: null,
};

const PERSONAS = [
  { id: 'p-zara', display_name: 'Zara', aliases: [], instructions: '', model_name: 'anthropic/haiku' },
  { id: 'p-nova', display_name: 'Nova', aliases: [], instructions: '', model_name: 'openai/gpt-4.1' },
];

/** Goes back to the assistant through the control's menu, as a person does. */
async function returnToDefault() {
  fireEvent.click(await screen.findByTitle('Choose a persona'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Aman' }));
}

async function unavailable(): Promise<never> {
  throw new Error('Unexpected persona API call');
}

function renderIndicator(overrides: Partial<PersonaApi>) {
  const api: PersonaApi = {
    ...personaKnowledgeApiStubs,
    listPersonas: async () => PERSONAS,
    createPersona: unavailable,
    updatePersona: unavailable,
    deletePersona: unavailable,
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
    ...overrides,
  };
  const tree = () => (
    <PersonaProvider api={api}>
      <ActivePersonaIndicator />
    </PersonaProvider>
  );
  const view = render(tree());
  return { ...view, rerenderTree: () => view.rerender(tree()) };
}

describe('ActivePersonaIndicator', () => {
  beforeEach(() => {
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' } }),
    );
  });

  it('shows on a new chat, and a pick there answers its first message', async () => {
    holdPersonaForNewChat(null);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { id: 'new-chat', remoteId: undefined } }),
    );
    const setSessionPersona = vi.fn(async () => NOVA);
    const getSessionPersona = vi.fn(async () => null);
    renderIndicator({ setSessionPersona, getSessionPersona });

    fireEvent.click(await screen.findByTitle('Choose a persona'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Nova' }));
    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Nova');
    // Nothing is sent before the chat exists; the session lookup never ran for a chat without one.
    expect(setSessionPersona).not.toHaveBeenCalled();
    expect(getSessionPersona).not.toHaveBeenCalled();

    // The chat's first turn applies the pick to the new session before it is admitted.
    await applyHeldPersona('sess-new');
    expect(setSessionPersona).toHaveBeenCalledWith('sess-new', 'p-nova');
    // Applied once: a later turn does not switch again.
    await applyHeldPersona('sess-new');
    expect(setSessionPersona).toHaveBeenCalledTimes(1);
  });

  it('names who answers the chat on the control, and each choice with its model in the menu', async () => {
    renderIndicator({ getSessionPersona: async () => ZARA });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    fireEvent.click(screen.getByTitle('Choose a persona'));
    const menu = screen.getByRole('menu', { name: 'Who answers this chat' });
    expect(menu).toHaveTextContent('Who answers this chat');
    expect(menu).toHaveTextContent('haiku');
  });

  it('sizes the trigger and the menu heading on the type scale, not a one-off literal', async () => {
    renderIndicator({ getSessionPersona: async () => ZARA });

    const trigger = await screen.findByTitle('Choose a persona');
    expect(trigger).toHaveClass('text-sm');
    expect(trigger.className).not.toMatch(/text-\[0\.8125rem\]/);

    fireEvent.click(trigger);
    const heading = screen.getByText('Who answers this chat');
    expect(heading).toHaveClass('text-xs');
    expect(heading.className).not.toMatch(/text-\[0\.75rem\]/);
  });

  it("shows the assistant's own display name while the chat is on the default assistant", async () => {
    renderIndicator({ getSessionPersona: async () => null });

    expect(await screen.findByTitle('Choose a persona')).toHaveTextContent('Aman');
    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
  });

  it('stays hidden while the list is loading, and when there is nobody to pick', async () => {
    let finishLoading!: (personas: typeof PERSONAS) => void;
    const pending = new Promise<typeof PERSONAS>(resolve => {
      finishLoading = resolve;
    });
    renderIndicator({ listPersonas: () => pending });
    expect(screen.queryByTitle('Choose a persona')).not.toBeInTheDocument();
    await act(async () => {
      finishLoading([]);
      await pending;
    });
    expect(screen.queryByTitle('Choose a persona')).not.toBeInTheDocument();
  });

  it('is a labelled control, never a bare arrow, titled for personas and never for agents or specialists', async () => {
    renderIndicator({ getSessionPersona: async () => null });

    const control = await screen.findByTitle('Choose a persona');
    expect(control.textContent?.trim()).not.toBe('');
    fireEvent.click(control);
    expect(screen.getByRole('menu', { name: 'Who answers this chat' })).toBeInTheDocument();
    const words = [document.body.textContent ?? '', control.getAttribute('title') ?? ''].join(' ');
    expect(words).not.toMatch(/\bagents?\b|specialist/i);
  });

  it('opens its menu fully inside the screen, even from a button near the bottom left', async () => {
    renderIndicator({ getSessionPersona: async () => null });
    const control = await screen.findByTitle('Choose a persona');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    control.getBoundingClientRect = () => new DOMRect(2, 800, 80, 32);

    fireEvent.click(control);
    const menu = screen.getByRole('menu', { name: 'Who answers this chat' });
    const left = Number.parseFloat(menu.style.left);
    const width = Number.parseFloat(menu.style.width);
    const bottom = Number.parseFloat(menu.style.bottom);
    const maxHeight = Number.parseFloat(menu.style.maxHeight);
    expect(menu.style.position).toBe('fixed');
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(390 - 8);
    // More room above the button, so it opens upward and never past the top of the screen.
    expect(menu.style.top).toBe('');
    expect(844 - bottom - maxHeight).toBeGreaterThanOrEqual(8);
    expect(menu.style.overflowY).toBe('auto');
  });

  it('returns to the default assistant in one action', async () => {
    let serverPersona = ZARA;
    const setSessionPersona = vi.fn(async (): Promise<SessionPersona> => {
      serverPersona = DEFAULT_SPEAKER;
      return DEFAULT_SPEAKER;
    });
    renderIndicator({ getSessionPersona: async () => serverPersona, setSessionPersona });

    await returnToDefault();

    await waitFor(() => {
      expect(setSessionPersona).toHaveBeenCalledWith('sess-1', null);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
    });
  });

  it('does not let a reset from the previous chat overwrite the new chat', async () => {
    let currentSessionId = 'sess-1';
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: currentSessionId } }),
    );
    let resolveReset!: (value: SessionPersona) => void;
    const resetPending = new Promise<SessionPersona>(resolve => {
      resolveReset = resolve;
    });
    const getSessionPersona = vi.fn(async (sessionId: string) => (sessionId === 'sess-1' ? ZARA : NOVA));
    const setSessionPersona = vi.fn(() => resetPending);
    const { rerenderTree } = renderIndicator({ getSessionPersona, setSessionPersona });

    await returnToDefault();
    currentSessionId = 'sess-2';
    rerenderTree();

    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledWith('sess-2'));
    await waitFor(() => expect(screen.getByTestId('active-persona')).toHaveTextContent('Nova'));

    resolveReset({
      persona_id: null,
      persona_name: null,
      model_name: null,
      source: 'default',
      turn_id: null,
    });
    await waitFor(() => expect(screen.getByTestId('active-persona')).toHaveTextContent('Nova'));
  });

  it('does not let a stale refresh overwrite a completed return to default', async () => {
    let resolveRefresh!: (value: SessionPersona) => void;
    const refreshPending = new Promise<SessionPersona>(resolve => {
      resolveRefresh = resolve;
    });
    let serverPersona = ZARA;
    let lookupCount = 0;
    const getSessionPersona = vi.fn(() => {
      lookupCount += 1;
      return lookupCount === 2 ? refreshPending : Promise.resolve(serverPersona);
    });
    const setSessionPersona = vi.fn(async (): Promise<SessionPersona> => {
      serverPersona = DEFAULT_SPEAKER;
      return DEFAULT_SPEAKER;
    });
    const { rerenderTree } = renderIndicator({ getSessionPersona, setSessionPersona });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    useThreadIsRunning.mockReturnValue(true);
    rerenderTree();
    useThreadIsRunning.mockReturnValue(false);
    rerenderTree();
    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledTimes(2));

    await returnToDefault();
    await waitFor(() => expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument());
    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveRefresh(ZARA);
      await refreshPending;
    });
    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
  });

  it('refreshes authoritatively after a turn and return-to-default mutation both settle', async () => {
    let serverPersona: SessionPersona = ZARA;
    let resolveReset!: (value: SessionPersona) => void;
    const resetPending = new Promise<SessionPersona>(resolve => {
      resolveReset = resolve;
    });
    const getSessionPersona = vi.fn(async () => serverPersona);
    const setSessionPersona = vi.fn(() => resetPending);
    const { rerenderTree } = renderIndicator({ getSessionPersona, setSessionPersona });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    await returnToDefault();
    await waitFor(() => expect(setSessionPersona).toHaveBeenCalledWith('sess-1', null));

    useThreadIsRunning.mockReturnValue(true);
    rerenderTree();
    useThreadIsRunning.mockReturnValue(false);
    rerenderTree();

    expect(getSessionPersona).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('active-persona')).toHaveTextContent('Zara');

    // The concurrent turn committed a newer persona after the reset began. The
    // mutation response alone is stale; the final lookup is authoritative.
    serverPersona = NOVA;
    await act(async () => {
      resolveReset(DEFAULT_SPEAKER);
      await resetPending;
    });

    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('active-persona')).toHaveTextContent('Nova'));
  });

  it('clears the previous persona while the new chat lookup is pending or fails', async () => {
    let currentSessionId = 'sess-1';
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: currentSessionId } }),
    );
    let rejectNewLookup!: (reason: Error) => void;
    const newLookup = new Promise<SessionPersona | null>((_resolve, reject) => {
      rejectNewLookup = reject;
    });
    const getSessionPersona = vi.fn((sessionId: string) =>
      sessionId === 'sess-1' ? Promise.resolve(ZARA) : newLookup,
    );
    const { rerenderTree } = renderIndicator({ getSessionPersona });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    currentSessionId = 'sess-2';
    rerenderTree();

    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledWith('sess-2'));

    await act(async () => {
      rejectNewLookup(new Error('lookup failed'));
      await newLookup.catch(() => undefined);
    });
    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('active-persona-unavailable')).toHaveTextContent('Speaker status unavailable');
    });
  });

  it('lets the user retry a transient speaker-status failure', async () => {
    let lookupCount = 0;
    const getSessionPersona = vi.fn(async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        throw new Error('temporary lookup failure');
      }
      return ZARA;
    });
    renderIndicator({ getSessionPersona });

    await screen.findByTestId('active-persona-unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry active speaker status' }));

    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
  });

  it('re-reads once a turn settles, since the server decides the persona', async () => {
    const getSessionPersona = vi.fn(async () => ZARA);
    useThreadIsRunning.mockReturnValue(true);
    const { rerenderTree } = renderIndicator({ getSessionPersona });

    expect(getSessionPersona).not.toHaveBeenCalled();

    useThreadIsRunning.mockReturnValue(false);
    rerenderTree();

    await waitFor(() => {
      expect(getSessionPersona).toHaveBeenCalledWith('sess-1');
    });
  });

  it('clears a previously visible persona when its post-turn refresh fails', async () => {
    let lookupCount = 0;
    const getSessionPersona = vi.fn(() => {
      lookupCount += 1;
      return lookupCount === 1 ? Promise.resolve(ZARA) : Promise.reject(new Error('refresh failed'));
    });
    const { rerenderTree } = renderIndicator({ getSessionPersona });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');

    useThreadIsRunning.mockReturnValue(true);
    rerenderTree();
    useThreadIsRunning.mockReturnValue(false);
    rerenderTree();

    await waitFor(() => expect(getSessionPersona).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument());
    expect(screen.getByTestId('active-persona-unavailable')).toHaveTextContent('Speaker status unavailable');
  });

  it('renders nothing when the host wired no persona API at all', () => {
    render(<ActivePersonaIndicator />);
    expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
  });
});
