// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { changeRequestReason } from '@truefoundry/trueforge-core/core/permissions/changeRequest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { respondToApproval, pendingApprovals } = vi.hoisted(() => ({
  respondToApproval: vi.fn(),
  pendingApprovals: { current: [] as Array<{ approvalId: string; threadId: string }> },
}));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return {
    ...actual,
    useTrueFoundryRespondToToolApproval: () => respondToApproval,
    useTrueFoundryApprovals: () => ({ pending: pendingApprovals.current, respond: respondToApproval }),
  };
});

function card(plain_what: string): SentinelApprovalCard {
  return {
    plain_what,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    email: null,
    calendar_event: null,
    schedule: null,
    persona: null,
  };
}

type ApprovalOptions = NonNullable<
  Extract<Exclude<ThreadMessageLike['content'], string>[number], { type: 'tool-call' }>['approval']
>['options'];

const ALLOW_ONCE_THEN_DENY: ApprovalOptions = [
  { id: 'allow-once', kind: 'allow-once' },
  { id: 'deny', kind: 'reject-once', confirm: {} },
];

function pendingCall(
  id: string,
  toolName: string,
  options: ApprovalOptions = ALLOW_ONCE_THEN_DENY,
): Exclude<ThreadMessageLike['content'], string>[number] {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName,
    args: {},
    interrupt: { type: 'human', payload: {} },
    approval: {
      id,
      approved: undefined,
      options,
    },
  };
}

type PendingCall = {
  id: string;
  tier: 2 | 3;
  /** The approval event that asked; calls of one event share it. */
  event?: string;
  /** Thread that owns the call. */
  thread?: string;
  /** Approval options the server declared; defaults to allow-once then deny. */
  options?: ApprovalOptions;
  /** What the server said about chat scope; absent from older servers. */
  chatAllowOffered?: boolean;
  /** What the server said about a standing "Always allow this tool"; absent when it did not say. */
  alwaysAllowOffered?: boolean;
};

/** Renders pending calls with the given tiers; the runtime reports each as awaiting approval. */
function renderPending(calls: PendingCall[], onRespondToToolApproval = vi.fn()) {
  const content = calls.map(call => pendingCall(call.id, `tool_${call.id}`, call.options));
  pendingApprovals.current = calls.map(call => ({ approvalId: call.id, threadId: call.thread ?? 'main' }));
  const message: ThreadMessageLike = {
    role: 'assistant',
    content,
    status: { type: 'requires-action', reason: 'tool-calls' },
  };
  render(
    <RuntimeHarness messages={[message]} onRespondToToolApproval={onRespondToToolApproval}>
      <SentinelStateProvider>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </SentinelStateProvider>
    </RuntimeHarness>,
  );
  act(() => {
    for (const call of calls) {
      publishSentinelEvent({
        toolCallId: call.id,
        tier: call.tier,
        card: card(`Do ${call.id}`),
        eventId: call.event ?? 'evt-1',
        threadId: call.thread ?? 'main',
        ...(call.chatAllowOffered === undefined ? {} : { chatAllowOffered: call.chatAllowOffered }),
        ...(call.alwaysAllowOffered === undefined ? {} : { alwaysAllowOffered: call.alwaysAllowOffered }),
      });
    }
  });
  return { onRespondToToolApproval };
}

/** The first button with this name; every Tier 2 card repeats the batch button, so any one will do. */
function firstButton(name: string): HTMLElement {
  const button = screen.getAllByRole('button', { name }).at(0);
  if (button === undefined) {
    throw new Error(`No button named ${name}`);
  }
  return button;
}

afterEach(() => {
  clearSentinelEventSubscribers();
  respondToApproval.mockClear();
});

describe('ToolCallContainer Sentinel approvals', () => {
  it('renders the plain-language card for a Tier 2 approval', () => {
    renderPending([{ id: 'a', tier: 2 }]);
    expect(screen.getByText('Do a')).toBeInTheDocument();
    expect(screen.getByText('Needs your OK')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('approves a single Tier 2 call through the part, without a batch button', () => {
    const { onRespondToToolApproval } = renderPending([{ id: 'a', tier: 2 }]);
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'a', approved: true }));
  });

  it('Approve all sends one allow per pending Tier 2 call id', () => {
    renderPending([
      { id: 'a', tier: 2 },
      { id: 'b', tier: 2 },
      { id: 'c', tier: 2 },
    ]);
    fireEvent.click(firstButton('Approve all (3)'));
    expect(respondToApproval.mock.calls).toEqual([
      [{ approvalId: 'a', approved: true, optionId: 'allow-once' }],
      [{ approvalId: 'b', approved: true, optionId: 'allow-once' }],
      [{ approvalId: 'c', approved: true, optionId: 'allow-once' }],
    ]);
  });

  it('Approve all sends allow-once for each call even when allow-chat is declared first', () => {
    const chatFirst: ApprovalOptions = [
      { id: 'allow-chat', kind: 'allow-always', label: 'Approve for this chat' },
      { id: 'allow-once', kind: 'allow-once' },
      { id: 'deny', kind: 'reject-once', confirm: {} },
    ];
    renderPending([
      { id: 'a', tier: 2, options: chatFirst },
      { id: 'b', tier: 2, options: chatFirst },
    ]);
    fireEvent.click(firstButton('Approve all (2)'));
    expect(respondToApproval.mock.calls).toEqual([
      [{ approvalId: 'a', approved: true, optionId: 'allow-once' }],
      [{ approvalId: 'b', approved: true, optionId: 'allow-once' }],
    ]);
  });

  it('Approve all sends a plain allow for a call that declares no allow-once option', () => {
    const chatOnly: ApprovalOptions = [
      { id: 'allow-chat', kind: 'allow-always' },
      { id: 'deny', kind: 'reject-once', confirm: {} },
    ];
    renderPending([
      { id: 'a', tier: 2, options: chatOnly },
      { id: 'b', tier: 2 },
    ]);
    fireEvent.click(firstButton('Approve all (2)'));
    expect(respondToApproval.mock.calls).toEqual([
      [{ approvalId: 'a', approved: true }],
      [{ approvalId: 'b', approved: true, optionId: 'allow-once' }],
    ]);
  });

  it('never batches a Tier 3 call and never offers Approve all on its card', () => {
    renderPending([
      { id: 'a', tier: 2 },
      { id: 'b', tier: 2 },
      { id: 'danger', tier: 3 },
    ]);
    const tier3Card = screen.getByText('Do danger').closest('div.rounded-lg');
    expect(tier3Card).not.toBeNull();
    if (tier3Card instanceof HTMLElement) {
      expect(within(tier3Card).queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
    }
    fireEvent.click(firstButton('Approve all (2)'));
    expect(respondToApproval.mock.calls.map(([response]) => response.approvalId)).toEqual(['a', 'b']);
  });

  it('does not offer Approve all for a lone Tier 2 call next to a Tier 3 call', () => {
    renderPending([
      { id: 'a', tier: 2 },
      { id: 'danger', tier: 3 },
    ]);
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it('Deny on a Tier 2 card denies only that call', () => {
    const { onRespondToToolApproval } = renderPending([
      { id: 'a', tier: 2 },
      { id: 'b', tier: 2 },
    ]);
    fireEvent.click(firstButton('Deny'));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'a', approved: false }));
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it('does not batch across sub-agent threads', () => {
    renderPending([
      { id: 'a', tier: 2 },
      { id: 'b', tier: 2 },
      { id: 'sub-1', tier: 2, thread: 'sub-agent' },
      { id: 'sub-2', tier: 2, thread: 'sub-agent' },
    ]);
    fireEvent.click(firstButton('Approve all (2)'));
    expect(respondToApproval.mock.calls.map(([response]) => response.approvalId)).toEqual(['a', 'b']);
  });

  it('does not batch a call from an earlier approval event', () => {
    renderPending([
      { id: 'old', tier: 2, event: 'evt-0' },
      { id: 'a', tier: 2 },
      { id: 'b', tier: 2 },
    ]);
    fireEvent.click(firstButton('Approve all (2)'));
    expect(respondToApproval.mock.calls.map(([response]) => response.approvalId)).toEqual(['a', 'b']);
  });

  it('offers no batch when the other Tier 2 calls belong to another thread or event', () => {
    renderPending([
      { id: 'a', tier: 2 },
      { id: 'sub', tier: 2, thread: 'sub-agent' },
      { id: 'old', tier: 2, event: 'evt-0' },
    ]);
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it.each([2, 3] as const)(
    'Approve on a Tier %i card sends allow-once even when allow-chat is declared first',
    tier => {
      const { onRespondToToolApproval } = renderPending([
        {
          id: 'a',
          tier,
          options: [
            { id: 'allow-chat', kind: 'allow-always', label: 'Approve for this chat' },
            { id: 'allow-once', kind: 'allow-once' },
            { id: 'deny', kind: 'reject-once', confirm: {} },
          ],
        },
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      expect(onRespondToToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: 'a', approved: true, optionId: 'allow-once' }),
      );
      // Chat scope is routed through the runtime hook; it must stay untouched.
      expect(respondToApproval).not.toHaveBeenCalled();
    },
  );

  it('Approve falls back to a plain single-use allow when no allow-once option is declared', () => {
    const { onRespondToToolApproval } = renderPending([
      {
        id: 'a',
        tier: 2,
        options: [
          { id: 'allow-chat', kind: 'allow-always' },
          { id: 'deny', kind: 'reject-once', confirm: {} },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const [response] = onRespondToToolApproval.mock.calls[0] ?? [];
    expect(response).toMatchObject({ approvalId: 'a', approved: true });
    expect(response).not.toHaveProperty('optionId');
    expect(respondToApproval).not.toHaveBeenCalled();
  });
  describe('Approve for this chat', () => {
    const declaredChat: ApprovalOptions = [
      { id: 'allow-once', kind: 'allow-once' },
      { id: 'allow-chat', kind: 'allow-always' },
      { id: 'deny', kind: 'reject-once', confirm: {} },
    ];

    it('is hidden when the server refuses chat scope, even if the option is declared', () => {
      renderPending([{ id: 'a', tier: 3, options: declaredChat, chatAllowOffered: false }]);
      expect(screen.queryByRole('button', { name: 'Approve for this chat' })).not.toBeInTheDocument();
    });

    it('is shown when the server offers it', () => {
      renderPending([{ id: 'a', tier: 3, options: declaredChat, chatAllowOffered: true }]);
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeInTheDocument();
    });

    it('follows the declared options when an older server says nothing', () => {
      renderPending([{ id: 'a', tier: 3, options: declaredChat }]);
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeInTheDocument();
    });
  });
});

describe('ToolCallContainer always allow this tool', () => {
  const ALWAYS_ALLOW_TOOL = 'Always allow this tool';

  it('offers Always allow this tool only on a card the server says may be always allowed', () => {
    renderPending([{ id: 'read', tier: 3, alwaysAllowOffered: true }]);
    expect(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL })).toBeInTheDocument();
  });

  it('never offers it when the server did not say so, or said no', () => {
    renderPending([
      { id: 'send', tier: 3 },
      { id: 'write', tier: 3, alwaysAllowOffered: false },
    ]);
    expect(screen.queryByRole('button', { name: ALWAYS_ALLOW_TOOL })).not.toBeInTheDocument();
  });

  it('asks for confirmation, and records nothing when the owner cancels', () => {
    renderPending([{ id: 'read', tier: 3, alwaysAllowOffered: true }]);
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));
    expect(screen.getByRole('heading', { name: 'Always allow this tool?' })).toBeInTheDocument();
    expect(respondToApproval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('always-allow-cancel'));
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it('approves the call with the standing option once the owner confirms', () => {
    renderPending([{ id: 'read', tier: 3, alwaysAllowOffered: true }]);
    fireEvent.click(screen.getByRole('button', { name: ALWAYS_ALLOW_TOOL }));
    fireEvent.click(screen.getByTestId('always-allow-confirm'));
    expect(respondToApproval.mock.calls).toEqual([
      [{ approvalId: 'read', approved: true, optionId: 'allow-standing' }],
    ]);
  });
});

describe('ToolCallContainer "Change it"', () => {
  const REASON = changeRequestReason('make it shorter');

  function renderMessage(message: ThreadMessageLike) {
    render(
      <RuntimeHarness messages={[message]}>
        <SentinelStateProvider>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </SentinelStateProvider>
      </RuntimeHarness>,
    );
  }

  it('shows the words the person typed as their own user message after the change request', () => {
    renderMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-mail',
          toolName: 'send_email',
          args: {},
          approval: { id: 'call-mail', approved: false, reason: REASON },
          result: { error: REASON },
          isError: true,
        },
      ],
      status: { type: 'complete', reason: 'stop' },
    });

    expect(screen.getByText('make it shorter')).toHaveAttribute('data-slot', 'aui_user-message-content');
  });

  it('shows no user message for an ordinary denial', () => {
    renderMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-mail',
          toolName: 'send_email',
          args: {},
          approval: { id: 'call-mail', approved: false, reason: 'not now' },
          result: { error: 'not now' },
          isError: true,
        },
      ],
      status: { type: 'complete', reason: 'stop' },
    });

    expect(document.querySelector('[data-slot="aui_user-message-content"]')).toBeNull();
  });

  describe('add a specialist card', () => {
    const personaCard: SentinelApprovalCard = {
      ...card('Add a specialist: Tutor. Helps with maths.'),
      persona: { name: 'Tutor', description: 'Helps with maths.', instructions: 'Be patient.', model_name: 'model-a' },
    };

    function renderPersonaApproval(onRespondToToolApproval = vi.fn()) {
      pendingApprovals.current = [{ approvalId: 'persona-1', threadId: 'main' }];
      const message: ThreadMessageLike = {
        role: 'assistant',
        content: [pendingCall('persona-1', 'create_persona')],
        status: { type: 'requires-action', reason: 'tool-calls' },
      };
      render(
        <RuntimeHarness messages={[message]} onRespondToToolApproval={onRespondToToolApproval}>
          <SentinelStateProvider>
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </SentinelStateProvider>
        </RuntimeHarness>,
      );
      act(() => {
        publishSentinelEvent({
          toolCallId: 'persona-1',
          tier: 3,
          card: personaCard,
          eventId: 'evt-persona',
          threadId: 'main',
        });
      });
      return { onRespondToToolApproval };
    }

    it('offers Change it between Approve and Deny', () => {
      renderPersonaApproval();
      const labels = screen
        .getAllByRole('button')
        .map(button => button.textContent)
        .filter(text => text === 'Approve' || text === 'Change it' || text === 'Deny');
      expect(labels).toEqual(['Approve', 'Change it', 'Deny']);
    });

    it('sends the words as the reason, declines the call, and never grants it', () => {
      const { onRespondToToolApproval } = renderPersonaApproval();
      fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
        target: { value: 'make it shorter' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(onRespondToToolApproval).toHaveBeenCalledTimes(1);
      expect(onRespondToToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: 'persona-1', approved: false, reason: REASON }),
      );
      expect(respondToApproval).not.toHaveBeenCalled();
    });
  });
});
