// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  };
}

function pendingCall(id: string, toolName: string): Exclude<ThreadMessageLike['content'], string>[number] {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName,
    args: {},
    interrupt: { type: 'human', payload: {} },
    approval: {
      id,
      approved: undefined,
      options: [
        { id: 'allow-once', kind: 'allow-once' },
        { id: 'deny', kind: 'reject-once', confirm: {} },
      ],
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
};

/** Renders pending calls with the given tiers; the runtime reports each as awaiting approval. */
function renderPending(calls: PendingCall[], onRespondToToolApproval = vi.fn()) {
  const content = calls.map(call => pendingCall(call.id, `tool_${call.id}`));
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
    expect(screen.getByText('Tier 2 check')).toBeInTheDocument();
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
      [{ approvalId: 'a', approved: true }],
      [{ approvalId: 'b', approved: true }],
      [{ approvalId: 'c', approved: true }],
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
});
