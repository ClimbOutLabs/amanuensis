// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { TerminalErrorContainer } from '@/containers/TerminalErrorContainer.js';
import { ComposerBusyProvider, useComposerBusyState } from '@/hooks/useComposerBusyState.js';
import type { AgentSpec } from '@/server/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { useTerminalError, agentSpecRef, reload } = vi.hoisted(() => {
  const agentSpecRef: { current: AgentSpec | undefined } = { current: undefined };
  return { useTerminalError: vi.fn(), agentSpecRef, reload: vi.fn() };
});

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>()),
  useTrueFoundryTerminalError: useTerminalError,
  useTrueFoundryAgentSpec: () => ({ agentSpec: agentSpecRef.current }),
  useTrueFoundryReload: () => reload,
}));

function SendProbe() {
  const { send } = useComposerBusyState();
  return (
    <button type="button" onClick={() => send(() => new Promise(() => {}))}>
      send
    </button>
  );
}

function terminalErrorTree(messages: ThreadMessageLike[]) {
  return (
    <RuntimeHarness messages={messages}>
      <ComposerBusyProvider>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        <TerminalErrorContainer />
        <SendProbe />
      </ComposerBusyProvider>
    </RuntimeHarness>
  );
}

function renderTerminalError(messages: ThreadMessageLike[]) {
  return render(terminalErrorTree(messages));
}

describe('TerminalErrorContainer', () => {
  beforeEach(() => {
    useTerminalError.mockReset();
    reload.mockClear();
    agentSpecRef.current = undefined;
    window.localStorage.clear();
  });

  it('renders an error when the failed turn has no assistant message', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-empty', message: 'stream stopped' });

    renderTerminalError([{ role: 'user', content: 'question' }]);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('stream stopped');
  });

  it('leaves the partial assistant error as the only banner for its turn', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-partial', message: 'stream stopped' });

    renderTerminalError([
      {
        role: 'assistant',
        content: 'partial answer',
        status: { type: 'incomplete', reason: 'error', error: 'stream stopped' },
        metadata: { custom: { turnId: 'turn-partial' } },
      },
    ]);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('stream stopped');
  });

  it('clears the banner as soon as the model changes', () => {
    agentSpecRef.current = { model: { name: 'openai/gpt-4.1' } };
    useTerminalError.mockReturnValue({
      turnId: 'turn-1',
      message: 'Request failed (400): Unexpected reasoning effort',
    });

    const { rerender } = renderTerminalError([{ role: 'user', content: 'question' }]);
    expect(screen.getByRole('alert')).toHaveTextContent('Unexpected reasoning effort');

    agentSpecRef.current = { model: { name: 'anthropic/claude-3.7-sonnet' } };
    rerender(terminalErrorTree([{ role: 'user', content: 'question' }]));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the banner as soon as the reasoning effort changes', () => {
    agentSpecRef.current = { model: { name: 'openai/gpt-4.1', params: { reasoningEffort: 'high' } } };
    useTerminalError.mockReturnValue({
      turnId: 'turn-2',
      message: 'Request failed (400): Unexpected reasoning effort',
    });

    const { rerender } = renderTerminalError([{ role: 'user', content: 'question' }]);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    agentSpecRef.current = { model: { name: 'openai/gpt-4.1', params: { reasoningEffort: 'medium' } } };
    rerender(terminalErrorTree([{ role: 'user', content: 'question' }]));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the banner as soon as a new send starts', () => {
    agentSpecRef.current = { model: { name: 'openai/gpt-4.1' } };
    useTerminalError.mockReturnValue({ turnId: 'turn-3', message: 'Request failed (422): Unknown model' });

    renderTerminalError([{ role: 'user', content: 'question' }]);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers Dismiss next to Retry on the failed turn banner', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-1', message: 'fetch failed' });

    renderTerminalError([{ role: 'user', content: 'question' }]);

    expect(screen.getByRole('alert')).toHaveTextContent('fetch failed');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('hides the banner when Dismiss is pressed, and it stays hidden after a remount', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-2', message: 'fetch failed' });

    const first = renderTerminalError([{ role: 'user', content: 'question' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A full reload throws away component state; the dismissal is stored in
    // the browser, so the banner does not come back.
    first.unmount();
    renderTerminalError([{ role: 'user', content: 'question' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Retry asks for a reload and leaves the banner standing', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-retry-1', message: 'fetch failed' });

    renderTerminalError([{ role: 'user', content: 'question' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('fetch failed');
  });

  it('dismissing one failed turn does not hide a later failure', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-3', message: 'first failure' });

    const { rerender } = renderTerminalError([{ role: 'user', content: 'question' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-4', message: 'second failure' });
    rerender(terminalErrorTree([{ role: 'user', content: 'question 2' }]));

    expect(screen.getByRole('alert')).toHaveTextContent('second failure');
  });

  it('dismisses the banner while another turn is running, leaving that turn untouched', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-5', message: 'fetch failed' });

    renderTerminalError([
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: 'still working',
        status: { type: 'running' },
        metadata: { custom: { turnId: 'turn-running-1' } },
      },
    ]);

    expect(screen.getByRole('alert')).toHaveTextContent('fetch failed');
    expect(screen.getByText('Writing…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Writing…')).toBeInTheDocument();
  });

  it('keeps the message-level error as the only banner when the failed turn has an assistant message', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-partial-2', message: 'stream stopped' });

    renderTerminalError([
      {
        role: 'assistant',
        content: 'partial answer',
        status: { type: 'incomplete', reason: 'error', error: 'stream stopped' },
        metadata: { custom: { turnId: 'turn-partial-2' } },
      },
    ]);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('a new send still starts after the banner is dismissed', () => {
    useTerminalError.mockReturnValue({ turnId: 'turn-dismiss-6', message: 'fetch failed' });

    renderTerminalError([{ role: 'user', content: 'question' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a fresh failure for a new turn after a prior one was dismissed', () => {
    agentSpecRef.current = { model: { name: 'openai/gpt-4.1' } };
    useTerminalError.mockReturnValue({ turnId: 'turn-4', message: 'Request failed (400): first' });

    const { rerender } = renderTerminalError([{ role: 'user', content: 'question' }]);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    useTerminalError.mockReturnValue({ turnId: 'turn-5', message: 'Request failed (400): second' });
    rerender(terminalErrorTree([{ role: 'user', content: 'question 2' }]));

    expect(screen.getByRole('alert')).toHaveTextContent('second');
  });
});
