import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

import { ChatView, type ViewBlock } from '../src/chatEvents.js';

const WEB = 'https://nora.example:8443';
const AT = '2026-11-15T12:00:00.000Z';

function turnCreated(id: string, input: TrueForgeApi.TurnInputItem[]): TrueForgeApi.TurnCreatedEvent {
  return {
    id,
    type: 'turn.created',
    createdAt: AT,
    threadId: null,
    turnId: 'turn-1',
    previousTurnId: null,
    state: { status: 'running' },
    input,
  };
}

function delta(id: string, content: string): TrueForgeApi.ModelMessageDeltaEvent {
  return { id, type: 'model.message.delta', threadId: 'thread-1', content };
}

function modelMessage(
  id: string,
  content: TrueForgeApi.ModelMessageEventContent,
  toolCalls?: TrueForgeApi.ToolCall[],
): TrueForgeApi.ModelMessageEvent {
  return {
    id,
    type: 'model.message',
    createdAt: AT,
    threadId: 'thread-1',
    content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function toolCall(id: string, name: string, args: string): TrueForgeApi.ToolCall {
  return { id, type: 'function', function: { name, arguments: args }, toolInfo: { type: 'truefoundry-system', name } };
}

function executionStarted(id: string, toolCallId: string, toolName: string): TrueForgeApi.ToolExecutionStartedEvent {
  return { id, type: 'tool.execution_started', createdAt: AT, threadId: 'thread-1', toolCallId, toolName };
}

function toolResponse(
  id: string,
  toolCallId: string,
  disposition: 'executed_ok' | 'executed_nonzero' | 'denied',
): TrueForgeApi.ToolResponseEventV2Zero {
  return {
    id,
    type: 'tool.response.v2',
    createdAt: AT,
    threadId: 'thread-1',
    toolCallId,
    content: '',
    disposition,
    admissionProvenance: { source: 'automatic' },
  };
}

function approvalRequired(id: string, toolCallId: string): TrueForgeApi.ToolApprovalRequiredEvent {
  return {
    id,
    type: 'tool.approval_required',
    createdAt: AT,
    threadId: 'thread-1',
    toolCalls: [{ id: toolCallId, sourceEventId: id }],
  };
}

function turnDone(id: string, state: TrueForgeApi.TurnDoneEventState): TrueForgeApi.TurnDoneEvent {
  return { id, type: 'turn.done', createdAt: AT, threadId: null, state };
}

function doneState(requiredActions: TrueForgeApi.ActionRequiredEvent[] = []): TrueForgeApi.TurnStateDone {
  return { status: 'done', completedAt: AT, output: null, requiredActions };
}

function texts(view: ChatView): string[] {
  return view.blocks.map(block => (block.kind === 'tool' ? block.name : block.text));
}

function toolBlock(view: ChatView): Extract<ViewBlock, { kind: 'tool' }> {
  const block = view.blocks.find(candidate => candidate.kind === 'tool');
  if (block === undefined || block.kind !== 'tool') {
    throw new Error('Expected a tool block.');
  }
  return block;
}

describe('the chat event fold', () => {
  it('renders a streamed reply in order and finishes it', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Hello there' }]));
    view.apply(delta('e2', 'Hel'));
    view.apply(delta('e3', 'lo'));
    view.apply(modelMessage('e4', 'Hello Nora'));
    view.apply(turnDone('e5', doneState()));
    expect(view.blocks.map(block => block.kind)).toEqual(['user', 'assistant']);
    expect(texts(view)).toEqual(['Hello there', 'Hello Nora']);
    const assistant = view.blocks[1];
    expect(assistant?.kind === 'assistant' && assistant.streaming).toBe(false);
  });

  it('ignores events it has already seen, so a replay cannot double a reply', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Hi' }]));
    view.apply(delta('e2', 'Hel'));
    view.apply(delta('e2', 'Hel'));
    view.apply(delta('e3', 'lo'));
    const assistant = view.blocks[1];
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('Hello');
  });

  it('shows a tool call as a plain card and lands its outcome', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Find my invoices' }]));
    view.apply(
      modelMessage('e2', '', [toolCall('call-1', 'mcp__gmail__search_email', '{"query":"invoices from Nora"}')]),
    );
    view.apply(executionStarted('e3', 'call-1', 'mcp__gmail__search_email'));
    expect(toolBlock(view).outcome).toBeNull();
    view.apply(toolResponse('e4', 'call-1', 'executed_ok'));
    const block = toolBlock(view);
    expect(block.name).toBe('Search email');
    expect(block.detail).toBe('invoices from Nora');
    expect(block.outcome).toBe('done');
    view.apply(turnDone('e5', doneState()));
    // No empty assistant block is left behind by a tool-only message.
    expect(view.blocks.some(block => block.kind === 'assistant')).toBe(false);
  });

  it('replaces a picture in a message with the cannot-show line naming the web address', () => {
    const view = new ChatView(WEB);
    view.apply(
      turnCreated('e1', [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'What is in this picture?' },
            { type: 'file', name: 'garden.png', data: 'aGVsbG8=' },
          ],
        },
      ]),
    );
    expect(texts(view)[0]).toBe('What is in this picture?');
    const note = view.blocks.find(block => block.kind === 'note');
    expect(note?.kind === 'note' && note.text).toContain('cannot show');
    expect(note?.kind === 'note' && note.text).toContain(WEB);
  });

  it('marks a held tool call as waiting and collects the approval, with no note', () => {
    const view = new ChatView(WEB);
    const approval = approvalRequired('e3', 'call-1');
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Send that email' }]));
    view.apply(modelMessage('e2', '', [toolCall('call-1', 'send_email', '{"subject":"Hello"}')]));
    view.apply(approval);
    expect(toolBlock(view).outcome).toBe('waiting_approval');
    view.apply(turnDone('e4', doneState([approval])));
    const pending = view.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe('call-1');
    expect(pending[0]?.threadId).toBe('thread-1');
    expect(pending[0]?.toolName).toBe('Send email');
    expect(view.blocks.some(block => block.kind === 'note')).toBe(false);
  });

  it('drops the waiting approval when the call runs', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Send that email' }]));
    view.apply(modelMessage('e2', '', [toolCall('call-1', 'send_email', '{"subject":"Hello"}')]));
    view.apply(approvalRequired('e3', 'call-1'));
    expect(view.pendingApprovals()).toHaveLength(1);
    view.apply(toolResponse('e4', 'call-1', 'executed_ok'));
    expect(view.pendingApprovals()).toHaveLength(0);
    expect(toolBlock(view).outcome).toBe('done');
  });

  it('keeps the partial reply and marks it stopped when a turn is cancelled', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Tell me a story' }]));
    view.apply(delta('e2', 'Once upon a'));
    view.apply(turnDone('e3', { status: 'cancelled', completedAt: AT, reason: 'client-cancelled' }));
    const assistant = view.blocks.find(block => block.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('Once upon a');
    expect(assistant?.kind === 'assistant' && assistant.streaming).toBe(false);
    const note = view.blocks.find(block => block.kind === 'note');
    expect(note?.kind === 'note' && note.text).toBe('This reply was stopped.');
  });

  it('fills in the card of a waiting approval learned without one', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Send that email' }]));
    view.apply(modelMessage('e2', '', [toolCall('call-1', 'send_email', '{"subject":"Hello"}')]));
    view.apply(approvalRequired('e3', 'call-1'));
    expect(view.pendingApprovals()[0]?.card).toBeNull();
    view.registerPending({
      toolCallId: 'call-1',
      threadId: 'thread-1',
      card: {
        amount: null,
        cannotBeUndone: null,
        copy: { headline: 'Send this email?', consequence: null, reason: null },
        destination: null,
        destinationHost: null,
        outboundText: null,
        outboundTruncated: false,
        parsedCommand: null,
        plainWhat: 'Send an email.',
        plainWhy: null,
        recipient: null,
        whyAskedAgain: null,
      },
      toolName: null,
      canAlwaysAllow: false,
      held: false,
      expiresAt: null,
    });
    const pending = view.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.card?.copy?.headline).toBe('Send this email?');
    // The tool name the fold already knew is not wiped by the later read.
    expect(pending[0]?.toolName).toBe('Send email');
  });

  it('shows a plain line when a turn ends in an error', () => {
    const view = new ChatView(WEB);
    view.apply(turnCreated('e1', [{ type: 'user.message', content: 'Hi' }]));
    view.apply(turnDone('e2', { status: 'error', completedAt: AT, message: 'boom' }));
    const note = view.blocks.find(block => block.kind === 'note');
    expect(note?.kind === 'note' && note.text).toBe('Something went wrong with that reply. Send your message again.');
  });
});
