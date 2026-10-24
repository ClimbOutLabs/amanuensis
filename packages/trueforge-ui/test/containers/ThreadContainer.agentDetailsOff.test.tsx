// @vitest-environment jsdom
import type { ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ThreadContainer } from '@/containers/ThreadContainer.js';
import { AgentDetailsHarness, settleAgentDetails } from './agentDetailsHarness.js';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

const FIRST_ANSWER = 'Here is the first answer.';
const STATUS_LINE = 'Let me look that up for you.';

/** One finished turn with a tool call, then the person's next message. */
const finishedTurn: ThreadMessageLike[] = [
  { role: 'user', content: [{ type: 'text', text: 'first question' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: STATUS_LINE },
      {
        type: 'tool-call',
        toolCallId: 'earlier-tool',
        toolName: 'read_note',
        args: { id: 'n1' },
        argsText: '{"id":"n1"}',
        result: { ok: true },
      },
      { type: 'text', text: FIRST_ANSWER },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'second question' }] },
];

/** The second turn, still running: reasoning so far, then a tool call in flight. */
const runningTurn: ThreadMessageLike = {
  role: 'assistant',
  status: { type: 'running' },
  content: [
    { type: 'reasoning', text: 'pondering' },
    { type: 'tool-call', toolCallId: 'live-tool', toolName: 'lookup_notes', args: {}, argsText: '{}' },
  ],
};

function thread({
  messages,
  agentDetails,
  isRunning = true,
}: {
  messages: ThreadMessageLike[];
  agentDetails: 'collapsed' | 'expanded';
  isRunning?: boolean;
}) {
  return (
    <AgentDetailsHarness agentDetails={agentDetails} messages={messages} isRunning={isRunning}>
      <ThreadContainer />
    </AgentDetailsHarness>
  );
}

/** No step rows, no tool names, and no tool detail text from any turn reaches the person. */
function expectNoWorkShown(): void {
  expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
  for (const name of [/read_note/, /lookup_notes/, /pondering/]) {
    for (const element of screen.queryAllByText(name)) expect(element).not.toBeVisible();
  }
}

describe('agent details off in a thread with a long running turn', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  });

  it('keeps the finished turn folded while the next turn is still starting', async () => {
    render(thread({ messages: finishedTurn, agentDetails: 'collapsed' }));
    await settleAgentDetails();
    expect(screen.getByText(FIRST_ANSWER)).toBeVisible();
    // The finished turn's working narration is hidden with its steps.
    for (const element of screen.queryAllByText(STATUS_LINE)) expect(element).not.toBeVisible();
    expectNoWorkShown();
  });

  it('keeps every turn folded as the running turn grows', async () => {
    const { rerender } = render(thread({ messages: finishedTurn, agentDetails: 'collapsed' }));
    await settleAgentDetails();

    rerender(
      thread({
        messages: [
          ...finishedTurn,
          { role: 'assistant', status: { type: 'running' }, content: [{ type: 'reasoning', text: 'pondering' }] },
        ],
        agentDetails: 'collapsed',
      }),
    );
    expectNoWorkShown();

    rerender(thread({ messages: [...finishedTurn, runningTurn], agentDetails: 'collapsed' }));
    expectNoWorkShown();
    expect(screen.getByText(FIRST_ANSWER)).toBeVisible();
  });

  it('keeps every turn folded after a remount mid-turn, as a page reload does', async () => {
    const messages = [...finishedTurn, runningTurn];
    const first = render(thread({ messages, agentDetails: 'collapsed' }));
    await settleAgentDetails();
    first.unmount();

    render(thread({ messages, agentDetails: 'collapsed' }));
    await settleAgentDetails();
    expect(screen.getByText(FIRST_ANSWER)).toBeVisible();
    expectNoWorkShown();
  });

  it('shows the steps of both turns when agent details are on', async () => {
    render(thread({ messages: [...finishedTurn, runningTurn], agentDetails: 'expanded' }));
    await settleAgentDetails();
    expect(screen.getByText(FIRST_ANSWER)).toBeVisible();
    expect(screen.getAllByTestId('assistant-message-agent-internals').length).toBeGreaterThan(0);
    expect(screen.getByText(/read_note/)).toBeVisible();
  });
});
