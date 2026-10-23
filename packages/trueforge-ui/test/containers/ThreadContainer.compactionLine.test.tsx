// @vitest-environment jsdom
import type { ThreadMessageLike } from '@assistant-ui/react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ThreadContainer } from '@/containers/ThreadContainer.js';
import { clearContextCompaction, publishContextCompaction } from '@/utils/contextCompactionLive.js';
import { AGENT_DETAILS_SESSION_ID, AgentDetailsHarness, settleAgentDetails } from './agentDetailsHarness.js';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

const LINE = 'Tidying up the conversation so far so I can keep going.';

const question: ThreadMessageLike[] = [{ role: 'user', content: [{ type: 'text', text: 'and then?' }] }];

const replyStarted: ThreadMessageLike[] = [
  ...question,
  { role: 'assistant', status: { type: 'running' }, content: [{ type: 'text', text: 'So far' }] },
];

function thread(agentDetails: 'expanded' | 'collapsed', messages: ThreadMessageLike[]) {
  return (
    <AgentDetailsHarness agentDetails={agentDetails} messages={messages} isRunning>
      <ThreadContainer />
    </AgentDetailsHarness>
  );
}

describe('ThreadContainer while the chat history is being shortened', () => {
  // jsdom has no scrollTo, and the viewport's auto-scroll calls it while the thread grows.
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  });

  afterEach(() => {
    clearContextCompaction();
  });

  it.each(['expanded', 'collapsed'] as const)(
    'says so in the live line with details %s, and the line goes when the reply starts',
    async agentDetails => {
      const { rerender } = render(thread(agentDetails, question));
      await settleAgentDetails();
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();

      act(() => publishContextCompaction({ sessionId: AGENT_DETAILS_SESSION_ID, active: true }));
      expect(screen.getByText(LINE)).toBeInTheDocument();

      // The reply starting ends compaction on the stream and fills the message.
      act(() => publishContextCompaction({ sessionId: AGENT_DETAILS_SESSION_ID, active: false }));
      rerender(thread(agentDetails, replyStarted));
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
    },
  );

  it('does not show another chat being tidied', async () => {
    render(thread('collapsed', question));
    await settleAgentDetails();
    act(() => publishContextCompaction({ sessionId: 'another-chat', active: true }));
    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });
});
