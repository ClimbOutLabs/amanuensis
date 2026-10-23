// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuiState } from '@/assistant-ui.js';
import { resetWaitQueueTurnClocks, useWaitQueue, type WaitQueueView } from '@/hooks/useWaitQueue.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

type Captured = { role: string; view: WaitQueueView };

function Probe({ captured }: { captured: Captured[] }) {
  const role = useAuiState(s => s.message.role);
  const view = useWaitQueue();
  captured.push({ role, view });
  return null;
}

/** Drives the real hook through the real runtime from plain message fixtures. */
function captureViews(messages: ThreadMessageLike[], isRunning: boolean): Captured[] {
  const captured: Captured[] = [];
  render(
    <RuntimeHarness messages={messages} isRunning={isRunning}>
      <ThreadPrimitive.Messages>{() => <Probe captured={captured} />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
  return captured;
}

function assistantView(messages: ThreadMessageLike[], isRunning: boolean): WaitQueueView {
  const captured = captureViews(messages, isRunning);
  const found = captured.find(entry => entry.role === 'assistant');
  if (!found) throw new Error('no assistant message rendered');
  return found.view;
}

describe('useWaitQueue', () => {
  // The per-turn clock lives in module state so it survives remounts; clear it
  // so one test's turn can never resume another's clock.
  beforeEach(() => {
    resetWaitQueueTurnClocks();
  });

  it('derives Listening for a running turn with no parts yet', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '' },
      ],
      true,
    );

    expect(view.snapshot.activeStation).toBe('listening');
    expect(view.snapshot.microcopy).toBe('On it…');
    expect(view.longWait).toBe(false);
    expect(view.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('derives Doing from a live tool-call part, naming the tool', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: {} }],
        },
      ],
      true,
    );

    expect(view.snapshot.activeStation).toBe('doing');
    expect(view.snapshot.microcopy).toBe('Reading…');
  });

  it('never says a search the person said no to was searched', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'search-1',
              toolName: 'web_search',
              args: { query: 'Dana Example' },
              approval: { id: 'search-1', approved: false, reason: 'No thanks' },
              result: { error: 'No thanks' },
              isError: true,
            },
          ],
        },
      ],
      true,
    );

    expect(view.snapshot.ticks).not.toContain('Searched the web');
    expect(view.snapshot.ticks).toContain('Not done: you said no');
  });

  it('derives Writing from streaming text', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      true,
    );

    expect(view.snapshot.activeStation).toBe('writing');
    expect(view.snapshot.microcopy).toBe('Writing…');
  });

  it('settles stations when the turn is done', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done' },
      ],
      false,
    );

    expect(view.snapshot.activeStation).toBeNull();
    expect(view.snapshot.stations.find(s => s.id === 'writing')?.state).toBe('done');
    expect(view.snapshot.stations.find(s => s.id === 'doing')?.state).toBe('skipped');
  });

  describe('the long-wait clock', () => {
    const messages: ThreadMessageLike[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'web_search', args: {}, result: 'done' }],
      },
    ];

    function renderTurn(isRunning: boolean) {
      const captured: Captured[] = [];
      const view = render(
        <RuntimeHarness messages={messages} isRunning={isRunning}>
          <ThreadPrimitive.Messages>{() => <Probe captured={captured} />}</ThreadPrimitive.Messages>
        </RuntimeHarness>,
      );
      const latest = () => {
        const found = captured.filter(entry => entry.role === 'assistant').at(-1);
        if (!found) throw new Error('no assistant message rendered');
        return found.view;
      };
      const rerender = (running: boolean) => {
        view.rerender(
          <RuntimeHarness messages={messages} isRunning={running}>
            <ThreadPrimitive.Messages>{() => <Probe captured={captured} />}</ThreadPrimitive.Messages>
          </RuntimeHarness>,
        );
      };
      return { latest, rerender };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps counting real elapsed time while the model is thought to be working', async () => {
      const { latest } = renderTurn(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(17_000);
      });
      expect(latest().elapsedMs).toBeGreaterThanOrEqual(17_000);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(43_000);
      });
      expect(latest().elapsedMs).toBeGreaterThanOrEqual(60_000);
      expect(latest().longWait).toBe(true);
    });

    it('drops the count when the turn stops instead of freezing on the last value', async () => {
      const { latest, rerender } = renderTurn(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(17_000);
      });
      expect(latest().elapsedMs).toBeGreaterThanOrEqual(17_000);

      await act(async () => {
        rerender(false);
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(latest().elapsedMs).toBe(0);
      expect(latest().longWait).toBe(false);
    });
  });
});
