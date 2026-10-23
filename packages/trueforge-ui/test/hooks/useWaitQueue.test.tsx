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

  it('names reasoning with a live word count while it streams', () => {
    const view = assistantView(
      [
        { role: 'user', content: 'plan my week' },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'First check the calendar, then the open tasks.' }],
          status: { type: 'running' },
        },
      ],
      true,
    );

    expect(view.snapshot.microcopy).toBe('Reasoning… 8 words so far');
  });

  describe('the quiet clock', () => {
    function reasoningTurn(text: string): ThreadMessageLike[] {
      return [
        { role: 'user', content: 'plan my week' },
        { role: 'assistant', content: [{ type: 'reasoning', text }], status: { type: 'running' } },
      ];
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not call a turn slow while reasoning keeps streaming, only once it goes quiet', async () => {
      const captured: Captured[] = [];
      const harness = (text: string) => (
        <RuntimeHarness messages={reasoningTurn(text)} isRunning>
          <ThreadPrimitive.Messages>{() => <Probe captured={captured} />}</ThreadPrimitive.Messages>
        </RuntimeHarness>
      );
      const latest = () => {
        const found = captured.filter(entry => entry.role === 'assistant').at(-1);
        if (!found) throw new Error('no assistant message rendered');
        return found.view;
      };
      let text = 'Start.';
      const view = render(harness(text));
      for (let step = 0; step < 4; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        text = `${text} More.`;
        view.rerender(harness(text));
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(latest().elapsedMs).toBeGreaterThanOrEqual(40_000);
      expect(latest().longWait).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(latest().quietMs).toBeGreaterThanOrEqual(15_000);
      expect(latest().longWait).toBe(true);
    });
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
