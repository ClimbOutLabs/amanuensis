// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentStepsCardProps } from '@/atoms/adapters/AgentStepsCardAdapter.js';
import type { ReasoningCardProps } from '@/atoms/adapters/ReasoningCardAdapter.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { AgentDetailsHarness, settleAgentDetails } from './agentDetailsHarness.js';

function AgentStepsCardProbe({ children }: AgentStepsCardProps) {
  return <div>{children}</div>;
}

function ReasoningCardProbe({ content, isStreaming, headingText }: ReasoningCardProps) {
  return (
    <section
      data-testid="reasoning-probe"
      data-content={content}
      data-streaming={String(isStreaming)}
      data-heading={headingText}
    />
  );
}

function TestSubject({
  message,
  isRunning = false,
  agentDetails = 'expanded',
}: {
  message: ThreadMessageLike;
  isRunning?: boolean;
  agentDetails?: 'expanded' | 'collapsed';
}) {
  return (
    <AgentDetailsHarness agentDetails={agentDetails} messages={[message]} isRunning={isRunning}>
      <SlotsProvider
        overrides={{
          AgentStepsCard: AgentStepsCardProbe,
          ReasoningCard: ReasoningCardProbe,
        }}
      >
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </SlotsProvider>
    </AgentDetailsHarness>
  );
}

describe('ReasoningContainer', () => {
  it('reports streaming progress without forwarding raw reasoning to the slot', async () => {
    render(
      <TestSubject
        isRunning
        message={{
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'SYSTEM PROMPT: C:\\Users\\owner\\Uploads\\secret.txt' },
            { type: 'reasoning', text: 'second internal line' },
          ],
          status: { type: 'running' },
        }}
      />,
    );

    const probe = await screen.findByTestId('reasoning-probe');
    expect(probe).toHaveAttribute('data-content', '');
    expect(probe).toHaveAttribute('data-streaming', 'true');
    expect(probe).toHaveAttribute('data-heading', 'Thinking…');
    expect(screen.queryByText(/SYSTEM PROMPT|Uploads|internal line/)).not.toBeInTheDocument();
  });

  it('removes reasoning progress when a tool becomes the active streaming part', async () => {
    const toolRunningMessage: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Completed private notes' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'lookup_notes',
          args: {},
          argsText: '{}',
        },
      ],
      status: { type: 'running' },
    };
    const reasoningRunningMessage: ThreadMessageLike = {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'Thinking further' }],
      status: { type: 'running' },
    };
    const { rerender } = render(<TestSubject message={reasoningRunningMessage} isRunning />);
    await settleAgentDetails();

    expect(screen.getByTestId('reasoning-probe')).toHaveAttribute('data-content', '');
    rerender(<TestSubject message={toolRunningMessage} isRunning />);
    await waitFor(() => expect(screen.queryByTestId('reasoning-probe')).not.toBeInTheDocument());
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
    expect(screen.queryByText('Completed private notes')).not.toBeInTheDocument();
  });

  it('shows no reasoning progress while agent details are off', async () => {
    render(
      <TestSubject
        isRunning
        agentDetails="collapsed"
        message={{ role: 'assistant', content: [{ type: 'reasoning', text: 'private' }], status: { type: 'running' } }}
      />,
    );
    await settleAgentDetails();

    expect(screen.queryByTestId('reasoning-probe')).not.toBeInTheDocument();
  });
});
