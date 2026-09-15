// @vitest-environment jsdom
import { ThreadPrimitive, type RespondToToolApprovalOptions, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

function renderAssistantMessage(
  messages: ThreadMessageLike[],
  options?: { isRunning?: boolean; onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void },
) {
  return render(
    <RuntimeHarness
      messages={messages}
      isRunning={options?.isRunning}
      onRespondToToolApproval={options?.onRespondToToolApproval}
    >
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

function getAgentInternals(): HTMLElement {
  const disclosure = screen.getByTestId('assistant-message-agent-internals');
  if (!(disclosure instanceof HTMLElement)) throw new Error('Expected an agent internals disclosure');
  return disclosure;
}

describe('AssistantMessageContainer', () => {
  it('renders assistant text through the Markdown atom', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'hello world' }]);
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  it('passes the message error to MessageErrorBanner when the message failed', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: 'partial',
        status: { type: 'incomplete', reason: 'error', error: 'boom' },
      },
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('does not render an error banner for a healthy message', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'all good' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the action bar while the thread is running (streaming state)', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'typing...' }], { isRunning: true });
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('shows the action bar once the thread is idle', () => {
    renderAssistantMessage(
      [
        {
          role: 'assistant',
          content: 'done',
          createdAt: new Date('2026-07-09T14:06:04'),
        },
      ],
      { isRunning: false },
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('hides the branch indicator when there is only a single branch', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'hi' }]);
    expect(screen.queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument();
  });

  it('labels a running turn as waiting for the model when no tool is running', () => {
    renderAssistantMessage(
      [
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'private reasoning' }],
          status: { type: 'running' },
        },
      ],
      { isRunning: true },
    );

    expect(screen.getByText(/Waiting for model/)).toBeInTheDocument();
  });

  it('labels a running turn as executing tools when a tool part is running', () => {
    renderAssistantMessage(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tool-1',
              toolName: 'lookup_notes',
              args: {},
              argsText: '{}',
            },
          ],
          status: { type: 'running' },
        },
      ],
      { isRunning: true },
    );

    expect(screen.getByText(/Executing tools/)).toBeInTheDocument();
  });

  it('labels a real message-level tool approval pause as waiting for approval', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          {
            type: 'tool-call',
            toolCallId: 'tool-approval-1',
            toolName: 'write_notes',
            args: { path: 'notes.md' },
            argsText: '{"path":"notes.md"}',
            interrupt: { type: 'human', payload: {} },
            approval: {
              id: 'approval-1',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          },
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
    ]);

    expect(screen.getByText(/Waiting for approval/)).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Approval options for write_notes' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Allow once' })).toBeInTheDocument();
    expect(screen.queryByText(/queue|position|ahead/i)).not.toBeInTheDocument();
  });

  it('keeps the approval phase and controls inside the agent internals disclosure', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-approval-only',
            toolName: 'write_notes',
            args: { path: 'notes.md' },
            argsText: '{"path":"notes.md"}',
            interrupt: { type: 'human', payload: {} },
            approval: {
              id: 'approval-only',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          },
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
    ]);

    const internals = getAgentInternals();
    expect(within(internals).getByText(/1 step · 1 tool/)).toBeInTheDocument();
    expect(within(internals).getByRole('radiogroup', { name: 'Approval options for write_notes' })).toBeInTheDocument();
  });

  it('counts mixed-turn approval tools only inside the agent internals disclosure', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-complete',
            toolName: 'lookup_notes',
            args: {},
            argsText: '{}',
            result: { ok: true },
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-approval-mixed',
            toolName: 'write_notes',
            args: { path: 'notes.md' },
            argsText: '{"path":"notes.md"}',
            interrupt: { type: 'human', payload: {} },
            approval: {
              id: 'approval-mixed',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          },
          { type: 'text', text: 'The lookup is complete.' },
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
    ]);

    const cardContent = within(getAgentInternals());
    expect(cardContent.getByText(/2 steps · 2 tools/)).toBeInTheDocument();
    expect(cardContent.getByRole('radiogroup', { name: 'Approval options for write_notes' })).toBeInTheDocument();
    expect(cardContent.queryByText('The lookup is complete.')).not.toBeInTheDocument();
  });

  it('forwards the approval decision from inside the agent internals disclosure', () => {
    const onRespondToToolApproval = vi.fn();
    renderAssistantMessage(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tool-complete',
              toolName: 'lookup_notes',
              args: {},
              argsText: '{}',
              result: { ok: true },
            },
            {
              type: 'tool-call',
              toolCallId: 'tool-approval-1',
              toolName: 'write_notes',
              args: { path: 'notes.md' },
              argsText: '{"path":"notes.md"}',
              interrupt: { type: 'human', payload: {} },
              approval: {
                id: 'approval-1',
                options: [
                  { id: 'allow-once', kind: 'allow-once' },
                  { id: 'deny', kind: 'reject-once' },
                ],
              },
            },
          ],
          status: { type: 'requires-action', reason: 'tool-calls' },
        },
      ],
      { onRespondToToolApproval },
    );

    // The approval wait locks the disclosure open (no toggle) with an attention dot.
    const internals = getAgentInternals();
    expect(within(internals).queryByTestId('assistant-message-agent-internals-toggle')).not.toBeInTheDocument();
    const card = within(internals);
    expect(card.getByRole('radio', { name: 'Allow once' })).toBeVisible();
    expect(card.getByRole('radio', { name: 'Deny' })).toBeVisible();
    fireEvent.click(card.getByRole('radio', { name: 'Allow once' }));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-1', approved: true }),
    );
  });

  it('does not call a non-approval interrupt an approval wait', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          {
            type: 'tool-call',
            toolCallId: 'tool-input-1',
            toolName: 'request_input',
            args: {},
            argsText: '{}',
            interrupt: { type: 'human', payload: { prompt: 'Choose an option' } },
          },
        ],
        status: { type: 'requires-action', reason: 'interrupt' },
      },
    ]);

    expect(screen.queryByText('Waiting for approval')).not.toBeInTheDocument();
  });

  it('renders no internals row for a clean text-only turn', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'just a plain answer' }]);

    expect(screen.getByText('just a plain answer')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
  });

  it('summarizes completed tool turns as one faint line, collapsed with no chat-level preference stored', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          {
            type: 'tool-call',
            toolCallId: 'tool-done',
            toolName: 'lookup_notes',
            args: {},
            argsText: '{}',
            result: { ok: true },
          },
          { type: 'text', text: 'Here is what I found.' },
        ],
      },
    ]);

    const internals = getAgentInternals();
    expect(internals).toHaveTextContent(/2 steps · 1 tool/);
    expect(internals.querySelector('[hidden]')).not.toBeNull();
    expect(screen.queryByTestId('assistant-message-agent-internals-attention')).not.toBeInTheDocument();
  });

  it('renders the content with an attention dot when a tool errored, with no chat-level preference stored', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-err',
            toolName: 'lookup_notes',
            args: {},
            argsText: '{}',
            result: {
              schema_version: 'tool.response.v2',
              outcome: { disposition: 'executed_nonzero' },
              result: { error: 'lookup failed' },
            },
          },
        ],
      },
    ]);

    const internals = getAgentInternals();
    expect(internals.querySelector('[hidden]')).toBeNull();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
  });
});
