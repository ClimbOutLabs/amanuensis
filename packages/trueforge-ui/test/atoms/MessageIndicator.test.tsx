// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAuiState } from '@/assistant-ui.js';
import { MessageIndicator } from '@/atoms/MessageIndicator.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => <div data-testid="thinking-orb" />,
}));

/** Production mounts the indicator inside the assistant message container only. */
function ScopedIndicator() {
  const role = useAuiState(s => s.message.role);
  if (role !== 'assistant') return null;
  return <MessageIndicator className="host-indicator" />;
}

function renderIndicator(messages: ThreadMessageLike[], isRunning: boolean) {
  return render(
    <RuntimeHarness messages={messages} isRunning={isRunning}>
      <ThreadPrimitive.Messages>
        {() => (
          <div data-testid="message-scope">
            <ScopedIndicator />
          </div>
        )}
      </ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('MessageIndicator', () => {
  it('renders the wait queue at the indicator slot and preserves host styling', () => {
    renderIndicator(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '' },
      ],
      true,
    );

    const slots = screen.getAllByRole('status');
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0]?.closest('[data-slot="aui_assistant-message-indicator"]');
    if (!(slot instanceof HTMLElement)) throw new Error('indicator slot not found');
    expect(slot).toHaveClass('host-indicator');
    // Fresh running turn: the queue opens at Listening.
    expect(slot).toHaveTextContent('On it…');
    expect(slot).toHaveTextContent('Listening');
  });

  it('keeps the slot contract: one live region per indicator', () => {
    renderIndicator([{ role: 'assistant', content: 'hi' }], true);

    const slots = screen.getAllByTestId('message-scope');
    for (const scope of slots) {
      const liveRegions = scope.querySelectorAll('[role="status"]');
      expect(liveRegions.length).toBe(1);
    }
  });
});
