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

async function unavailable(): Promise<never> {
  throw new Error('Unexpected persona API call');
}

function renderIndicator(overrides: Partial<PersonaApi>) {
  const api: PersonaApi = {
    listPersonas: async () => [],
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

  it('names the persona answering the chat and the model it is on', async () => {
    renderIndicator({ getSessionPersona: async () => ZARA });

    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Zara');
    expect(screen.getByTestId('active-persona')).toHaveTextContent('haiku');
  });

  it('renders nothing while the chat is on the default assistant', async () => {
    renderIndicator({ getSessionPersona: async () => null });

    await waitFor(() => {
      expect(screen.queryByTestId('active-persona')).not.toBeInTheDocument();
    });
  });

  it('returns to the default assistant in one action', async () => {
    let serverPersona = ZARA;
    const setSessionPersona = vi.fn(async (): Promise<SessionPersona> => {
      serverPersona = DEFAULT_SPEAKER;
      return DEFAULT_SPEAKER;
    });
    renderIndicator({ getSessionPersona: async () => serverPersona, setSessionPersona });

    fireEvent.click(await screen.findByRole('button', { name: /Return to the default assistant/ }));

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

    fireEvent.click(await screen.findByRole('button', { name: /Return to the default assistant/ }));
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

    fireEvent.click(screen.getByRole('button', { name: /Return to the default assistant/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /Return to the default assistant/ }));
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
