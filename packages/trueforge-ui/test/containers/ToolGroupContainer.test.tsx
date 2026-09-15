// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

function renderMultiToolMessage(content: ThreadMessageLike['content'], isRunning = false) {
  const message: ThreadMessageLike = { role: 'assistant', content };
  return render(
    <RuntimeHarness messages={[message]} isRunning={isRunning}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('AgentSteps grouping', () => {
  it('groups consecutive tool calls under the agent internals disclosure', () => {
    renderMultiToolMessage([
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {}, result: 'a' },
      { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {}, result: 'b' },
    ]);
    // Completed turns collapse into the faint one-line summary…
    expect(screen.getByRole('region', { name: '2 steps · 2 tools' })).toBeInTheDocument();
    expect(screen.getByText('first_tool')).not.toBeVisible();
    // …and expand to reveal the grouped tool calls.
    fireEvent.click(screen.getByRole('button', { name: 'Expand agent details' }));
    expect(screen.getByText('first_tool')).toBeVisible();
    expect(screen.getByText('second_tool')).toBeVisible();
  });

  it('renders both nested tool calls once expanded (defaultOpen)', () => {
    renderMultiToolMessage([
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} },
      { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {} },
    ]);
    expect(screen.getByText('first_tool')).toBeInTheDocument();
    expect(screen.getByText('second_tool')).toBeInTheDocument();
  });

  it('collapses the group when the disclosure is toggled', () => {
    renderMultiToolMessage([
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} },
      { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {} },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand agent details' }));
    expect(screen.getByText('first_tool')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse agent details' }));
    expect(screen.getByText('first_tool')).not.toBeVisible();
  });

  it('uses singular label for exactly one tool call in the group', () => {
    renderMultiToolMessage([{ type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} }]);
    expect(screen.getByRole('region', { name: '1 step · 1 tool' })).toBeInTheDocument();
  });

  it('styles intermediate agent-step text muted and indented', () => {
    renderMultiToolMessage([
      { type: 'text', text: "I'll delegate this to a sub-agent." },
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {}, result: 'a' },
      { type: 'text', text: 'Here is the final answer.' },
    ]);
    // Auto-collapses once final answer is confirmed — expand to inspect step text
    fireEvent.click(screen.getByRole('button', { name: 'Expand agent details' }));
    const intermediate = screen.getByText("I'll delegate this to a sub-agent.");
    // Inside the disclosure the trace carries its own indentation; the
    // intermediate text is muted via text-text-secondary.
    const stepTextWrap = intermediate.closest('.text-text-secondary');
    expect(stepTextWrap).toHaveClass('mb-2', 'text-xs');
    const finalAnswer = screen.getByText('Here is the final answer.');
    // Final answer renders outside the internals trace.
    expect(finalAnswer.closest('[data-testid="assistant-message-agent-internals"]')).toBeNull();
  });
});
