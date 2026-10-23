// @vitest-environment jsdom
import type { ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ThreadContainer } from '@/containers/ThreadContainer.js';
import { AgentDetailsHarness, settleAgentDetails } from './agentDetailsHarness.js';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

/** A finished earlier turn with one tool call, so its agent details have something to show. */
const earlierTurn: ThreadMessageLike[] = [
  { role: 'user', content: [{ type: 'text', text: 'first question' }] },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'earlier-tool',
        toolName: 'lookup_notes',
        args: {},
        argsText: '{}',
        result: {
          schema_version: 'tool.response.v2',
          outcome: { disposition: 'executed_ok' },
          result: {},
        },
      },
      { type: 'text', text: 'first answer' },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'second question' }] },
];

function thread(messages: ThreadMessageLike[]) {
  return (
    <AgentDetailsHarness agentDetails="expanded" messages={messages} isRunning>
      <ThreadContainer />
    </AgentDetailsHarness>
  );
}

describe('ThreadContainer with agent details on while a turn runs', () => {
  // jsdom has no scrollTo, and the viewport's auto-scroll calls it while the thread grows.
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  });

  it('shows a live row from the moment the turn starts, before any stream event', async () => {
    render(thread(earlierTurn));
    await settleAgentDetails();

    // No stream event has arrived: the only assistant message is the runtime's running placeholder.
    const rows = screen.getAllByTestId('assistant-message-agent-internals');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('Waiting for model');
  });

  it('keeps the earlier turn details and the live row through reasoning and a tool call', async () => {
    const { rerender } = render(thread(earlierTurn));
    await settleAgentDetails();

    rerender(
      thread([
        ...earlierTurn,
        { role: 'assistant', status: { type: 'running' }, content: [{ type: 'reasoning', text: '' }] },
      ]),
    );
    expect(screen.getAllByTestId('assistant-message-agent-internals')).toHaveLength(2);

    rerender(
      thread([
        ...earlierTurn,
        {
          role: 'assistant',
          status: { type: 'running' },
          content: [{ type: 'tool-call', toolCallId: 'live-tool', toolName: 'run_code', args: {}, argsText: '{}' }],
        },
      ]),
    );
    expect(screen.getAllByTestId('assistant-message-agent-internals')).toHaveLength(2);
  });
});
