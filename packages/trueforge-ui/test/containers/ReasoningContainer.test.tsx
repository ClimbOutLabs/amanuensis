// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('passes the streamed reasoning to the card while agent details are on', async () => {
    render(
      <TestSubject
        isRunning
        message={{
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Look up the dentist visit.' },
            { type: 'reasoning', text: 'Then check Tuesday.' },
          ],
          status: { type: 'running' },
        }}
      />,
    );

    const probe = await screen.findByTestId('reasoning-probe');
    expect(probe).toHaveAttribute('data-content', 'Look up the dentist visit.\n\nThen check Tuesday.');
    expect(probe).toHaveAttribute('data-streaming', 'true');
    expect(probe).toHaveAttribute('data-heading', 'Thinking…');
  });

  it('keeps the reasoning text closed until the person opens the card', async () => {
    render(
      <AgentDetailsHarness
        agentDetails="expanded"
        isRunning
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'Compare the two flight times.' }],
            status: { type: 'running' },
          },
        ]}
      >
        <SlotsProvider overrides={{ AgentStepsCard: AgentStepsCardProbe }}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </SlotsProvider>
      </AgentDetailsHarness>,
    );
    await settleAgentDetails();

    expect(screen.queryByText('Compare the two flight times.')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand step' }));
    expect(await screen.findByText('Compare the two flight times.')).toBeInTheDocument();
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

    expect(screen.getByTestId('reasoning-probe')).toHaveAttribute('data-streaming', 'true');
    rerender(<TestSubject message={toolRunningMessage} isRunning />);
    await waitFor(() => expect(screen.queryByTestId('reasoning-probe')).not.toBeInTheDocument());
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
    expect(screen.queryByText('Completed private notes')).not.toBeInTheDocument();
  });

  it('gives the card slot no reasoning text once the reply has finished', async () => {
    render(
      <TestSubject
        message={{
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Finished private notes' },
            { type: 'text', text: 'Here is your plan.' },
          ],
          status: { type: 'complete', reason: 'stop' },
        }}
      />,
    );
    await settleAgentDetails();

    expect(screen.queryByTestId('reasoning-probe')).not.toBeInTheDocument();
    expect(screen.queryByText('Finished private notes')).not.toBeInTheDocument();
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
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });
});
