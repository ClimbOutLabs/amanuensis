// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { render } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';

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
});
