// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { answerHeldAction, reload, server } = vi.hoisted(() => {
  const answer = vi.fn();
  const current: { value: object | null } = {
    value: {
      peekSessionTip: vi.fn(),
      dismissPendingApprovals: vi.fn(),
      answerHeldAction: answer,
      getLastCompactionStatus: vi.fn(),
      getLastTurnInputTokens: vi.fn(),
    },
  };
  return { answerHeldAction: answer, reload: vi.fn(), server: current };
});

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return { ...actual, useTrueFoundryReload: () => reload };
});

vi.mock('@/server/ServerContext.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/ServerContext.js')>();
  return { ...actual, useOptionalServer: () => server.value };
});

function card(overrides: Partial<SentinelApprovalCard> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Send a note to Ana.',
    plain_why: 'It was on the Monday list.',
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: 'ana@example.com',
    amount: null,
    parsed_command: null,
    outbound_text: 'body: Lunch at noon?',
    destination_host: null,
    outbound_truncated: false,
    ...overrides,
  };
}

function heldCall(id: string): Exclude<ThreadMessageLike['content'], string>[number] {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: 'send_note',
    args: {},
    result: { held: 'waiting' },
  };
}

function renderBrief(
  input: { status?: 'running' | 'complete'; alwaysAllowOffered?: boolean; expiresAt?: string } = {},
) {
  const message: ThreadMessageLike = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Here is your brief.' }, heldCall('call-held'), heldCall('call-plain')],
    status: input.status === 'running' ? { type: 'running' } : { type: 'complete', reason: 'stop' },
  };
  render(
    <RuntimeHarness messages={[message]} remoteId="session-1" threadId="thread-1">
      <SentinelStateProvider>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </SentinelStateProvider>
    </RuntimeHarness>,
  );
  act(() => {
    publishSentinelEvent({
      toolCallId: 'call-held',
      tier: 3,
      card: card(),
      eventId: 'evt-1',
      threadId: 'main',
      held: { alwaysAllowOffered: input.alwaysAllowOffered ?? false, expiresAt: input.expiresAt ?? null },
    });
    publishSentinelEvent({
      toolCallId: 'call-plain',
      tier: 3,
      card: card({ plain_what: 'Not held' }),
      eventId: 'evt-1',
      threadId: 'main',
    });
  });
}

afterEach(() => {
  clearSentinelEventSubscribers();
  answerHeldAction.mockReset();
  reload.mockReset();
});

describe('NeedsYourOkContainer', () => {
  it('ends a finished message with a block of the held actions and nothing else', () => {
    renderBrief();
    expect(screen.getByRole('heading', { name: 'Needs your OK' })).toBeInTheDocument();
    expect(screen.getByText('Aman held these for you. Nothing has been done yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Send a note to Ana.')).toBeInTheDocument();
    expect(screen.queryByText('Not held')).not.toBeInTheDocument();
  });

  it('waits for the run to end before it asks for an answer', () => {
    renderBrief({ status: 'running' });
    expect(screen.queryByRole('heading', { name: 'Needs your OK' })).not.toBeInTheDocument();
  });

  it('approves exactly the held call once, then reloads the chat to show the result', async () => {
    answerHeldAction.mockResolvedValue(undefined);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText('Approved.')).toBeInTheDocument();
    });
    expect(answerHeldAction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'main',
      toolCallId: 'call-held',
      answer: 'approve',
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('sends Always allow only where the server offered it', async () => {
    answerHeldAction.mockResolvedValue(undefined);
    renderBrief({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => {
      expect(answerHeldAction).toHaveBeenCalledWith(expect.objectContaining({ answer: 'always_allow' }));
    });
  });

  it('records a denial without running anything', async () => {
    answerHeldAction.mockResolvedValue(undefined);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(screen.getByText('Denied. Nothing was done.')).toBeInTheDocument();
    });
    expect(answerHeldAction).toHaveBeenCalledWith(expect.objectContaining({ answer: 'deny' }));
  });

  it('shows the server refusal for an expired action in plain words and offers no retry', async () => {
    const refusal = Object.assign(new Error('Unprocessable'), {
      statusCode: 422,
      body: { error: { message: 'Expired, nothing was done. Ask again in chat.' } },
    });
    answerHeldAction.mockRejectedValue(refusal);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText('Expired, nothing was done. Ask again in chat.')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the buttons and says so when the answer did not go through', async () => {
    answerHeldAction.mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText('That did not go through. Try again in a moment.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('shows an action whose hold already ran out as expired, with no buttons', () => {
    renderBrief({ expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(screen.getByText('Expired, nothing was done. Ask again in chat.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
