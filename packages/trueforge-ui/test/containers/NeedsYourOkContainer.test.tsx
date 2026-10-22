// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';
import { changeRequestReason } from '@truefoundry/trueforge-core/core/permissions/changeRequest';
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
    email: null,
    calendar_event: null,
    schedule: null,
    persona: null,
    ...overrides,
  };
}

const MAIL: NonNullable<SentinelApprovalCard['email']> = {
  action: 'send',
  to: [{ name: 'Ana', address: 'ana@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lunch',
  body: 'Lunch at noon?',
  replaces: null,
  reply_in_thread: null,
  reply_to: null,
};

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
  input: {
    status?: 'running' | 'complete';
    alwaysAllowOffered?: boolean;
    expiresAt?: string;
    notSaved?: number;
    heldCards?: boolean;
    editable?: boolean;
  } = {},
) {
  const message: ThreadMessageLike = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here is your brief.' },
      heldCall('call-held'),
      heldCall('call-plain'),
      ...Array.from({ length: input.notSaved ?? 0 }, (_, index) => heldCall(`call-dropped-${index}`)),
    ],
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
      card: input.editable ? card({ email: MAIL }) : card(),
      eventId: 'evt-1',
      threadId: 'main',
      ...(input.heldCards === false
        ? { notSaved: 'too_many' as const }
        : { held: { expiresAt: input.expiresAt ?? null }, alwaysAllowOffered: input.alwaysAllowOffered ?? false }),
    });
    for (let index = 0; index < (input.notSaved ?? 0); index += 1) {
      publishSentinelEvent({
        toolCallId: `call-dropped-${index}`,
        tier: 3,
        card: card({ plain_what: 'Dropped' }),
        eventId: 'evt-2',
        threadId: 'main',
        notSaved: 'too_many',
      });
    }
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

  it('approves exactly the held call once, shows what came of it, then reloads the chat', async () => {
    answerHeldAction.mockResolvedValue('done');
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText('Approved and done.')).toBeInTheDocument();
    });
    expect(answerHeldAction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'main',
      toolCallId: 'call-held',
      answer: 'approve',
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', 'Approved, but it failed. The details are in the chat.'],
    ['unclear', 'Approved, but it is not clear whether it finished. Check the chat.'],
    ['not_run', 'Approved, but it did not run, so nothing was done. Ask again in chat.'],
  ] as const)('does not call an approved action done when it %s', async (outcome, text) => {
    answerHeldAction.mockResolvedValue(outcome);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText(text)).toBeInTheDocument();
    });
    expect(screen.queryByText('Approved and done.')).not.toBeInTheDocument();
  });

  it('sends Always allow only where the server offered it', async () => {
    answerHeldAction.mockResolvedValue(undefined);
    renderBrief({ alwaysAllowOffered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Always allow this tool' }));
    fireEvent.click(screen.getByTestId('always-allow-confirm'));
    await waitFor(() => {
      expect(answerHeldAction).toHaveBeenCalledWith(expect.objectContaining({ answer: 'always_allow' }));
    });
  });

  it('shows Change it words as the owner message, and sends them as the reason without running anything', async () => {
    answerHeldAction.mockResolvedValue(undefined);
    renderBrief({ editable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
      target: { value: 'make it shorter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByText('make it shorter')).toHaveAttribute('data-slot', 'aui_user-message-content');
    });
    expect(answerHeldAction).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'deny',
        toolCallId: 'call-held',
        reason: changeRequestReason('make it shorter'),
      }),
    );
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

  function refusal(statusCode: number, code: string, message = 'raw validation text from the server') {
    return Object.assign(new Error(message), { statusCode, body: { error: { code, message } } });
  }

  it.each([
    [409, 'held_action_expired', 'Expired, nothing was done. Ask again in chat.'],
    [409, 'held_action_changed', 'This no longer matches what was held, so nothing was done. Ask again in chat.'],
    [409, 'held_action_not_allowed', 'This is not allowed any more, so nothing was done. Ask again in chat.'],
    [409, 'held_action_tool_gone', 'This tool is not available any more, so nothing was done. Ask again in chat.'],
    [
      409,
      'held_action_sign_in',
      'The connector needs you to sign in again first, so nothing was done. Sign in, then try again.',
    ],
    [422, 'invalid_request', 'This saved action is no longer available. Ask again in chat.'],
  ])(
    'maps a %s %s refusal to plain words, offers no retry, and never shows the raw text',
    async (status, code, text) => {
      answerHeldAction.mockRejectedValue(refusal(status, code));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderBrief();
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => {
        expect(screen.getByText(text)).toBeInTheDocument();
      });
      expect(screen.queryByText(/raw validation text/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('keeps the buttons when the chat is only busy', async () => {
    answerHeldAction.mockRejectedValue(refusal(409, 'previous_turn_running'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderBrief();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByText('This chat is still busy. Try again in a moment.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
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

  it('says how many actions were not saved, below the cards', () => {
    renderBrief({ notSaved: 3 });
    expect(
      screen.getByText(
        "3 more actions weren't saved because too many were waiting. Ask again in chat if you need them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('says so on its own, without the held-for-you intro, when nothing could be saved', () => {
    renderBrief({ notSaved: 1, heldCards: false });
    expect(
      screen.getByText(
        "2 more actions weren't saved because too many were waiting. Ask again in chat if you need them.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs your OK' })).not.toBeInTheDocument();
  });
});
