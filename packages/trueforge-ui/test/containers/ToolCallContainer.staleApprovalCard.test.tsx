// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { pendingApprovals } = vi.hoisted(() => ({
  pendingApprovals: { current: [] as Array<{ approvalId: string; threadId: string }> },
}));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return {
    ...actual,
    useTrueFoundryRespondToToolApproval: () => vi.fn(),
    useTrueFoundryApprovals: () => ({ pending: pendingApprovals.current, respond: vi.fn() }),
  };
});

function card(plain_what: string, outbound_text: string | null = null): SentinelApprovalCard {
  return {
    plain_what,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text,
    destination_host: null,
    outbound_truncated: false,
  };
}

const OPTIONS = [
  { id: 'allow-once', kind: 'allow-once' as const },
  { id: 'deny', kind: 'reject-once' as const, confirm: {} },
];

type Part = Exclude<ThreadMessageLike['content'], string>[number];

function call(id: string, state: 'pending' | 'approved'): Part {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: `tool_${id}`,
    args: {},
    ...(state === 'pending' ? { interrupt: { type: 'human' as const, payload: {} } } : { result: 'ok' }),
    approval: { id, approved: state === 'pending' ? undefined : true, options: OPTIONS },
  };
}

function message(id: string, parts: Part[], pending: boolean): ThreadMessageLike {
  return {
    id,
    role: 'assistant',
    content: parts,
    status: pending ? { type: 'requires-action', reason: 'tool-calls' } : { type: 'complete', reason: 'stop' },
  };
}

function tree(messages: ThreadMessageLike[]): ReactNode {
  return (
    <RuntimeHarness messages={messages}>
      <SentinelStateProvider>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </SentinelStateProvider>
    </RuntimeHarness>
  );
}

function publish(id: string, plainWhat: string, outbound: string | null = null, sourceEventId?: string): void {
  act(() => {
    publishSentinelEvent({
      toolCallId: id,
      tier: 3,
      card: card(plainWhat, outbound),
      eventId: `evt-${id}`,
      threadId: 'main',
      ...(sourceEventId === undefined ? {} : { sourceEventId }),
    });
  });
}

afterEach(() => {
  clearSentinelEventSubscribers();
});

/** Lets the runtime publish a new message list to the rendered parts. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Every distinct body text the DOM showed from now on, so a one-frame flash is caught. */
function recordFrames(): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const observer = new MutationObserver(() => {
    frames.push(document.body.textContent ?? '');
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return {
    frames,
    stop: () => {
      frames.push(...observer.takeRecords().map(() => document.body.textContent ?? ''));
      observer.disconnect();
    },
  };
}

describe('a second approval after a resolved one', () => {
  it('never shows the first card in the second approval slot, including while the second card is in flight', async () => {
    pendingApprovals.current = [{ approvalId: 'a', threadId: 'main' }];
    const { rerender } = render(tree([message('m1', [call('a', 'pending')], true)]));
    await settle();
    publish('a', 'Do a');
    expect(screen.getByText('Do a')).toBeInTheDocument();

    const recording = recordFrames();
    // A is answered: it must stop reading as pending right away.
    pendingApprovals.current = [];
    rerender(tree([message('m1', [call('a', 'approved')], false)]));
    await settle();
    expect(screen.queryByText('Do a')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    // B arrives as a pending call before its card has been delivered.
    pendingApprovals.current = [{ approvalId: 'b', threadId: 'main' }];
    rerender(tree([message('m1', [call('a', 'approved'), call('b', 'pending')], true)]));
    await settle();
    expect(screen.queryByText('Do a')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Approve' }).length).toBeLessThanOrEqual(1);

    publish('b', 'Do b');
    await settle();
    expect(screen.getByText('Do b')).toBeInTheDocument();
    recording.stop();

    const firstFrameWithoutA = recording.frames.findIndex(text => !text.includes('Do a'));
    expect(firstFrameWithoutA).toBeGreaterThanOrEqual(0);
    expect(recording.frames.slice(firstFrameWithoutA).filter(text => text.includes('Do a'))).toEqual([]);
  });

  it('does not carry the first card local state onto a different approval in the same slot', async () => {
    const longText = 'x'.repeat(700);
    pendingApprovals.current = [{ approvalId: 'a', threadId: 'main' }];
    const { rerender } = render(tree([message('m1', [call('a', 'pending')], true)]));
    await settle();
    publish('a', 'Do a', longText);
    publish('b', 'Do b', longText);
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();

    // The turn moves on and a different approval takes the same position.
    pendingApprovals.current = [{ approvalId: 'b', threadId: 'main' }];
    rerender(tree([message('m1', [call('b', 'pending')], true)]));
    await settle();
    expect(screen.getByText('Do b')).toBeInTheDocument();
    expect(screen.queryByText('Do a')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show all/ })).toBeInTheDocument();
  });

  it('does not show the first card for a second approval that reuses the same tool call id', async () => {
    // Models can repeat call ids across turns; the runtime tells the calls apart by their source event.
    const first = 'src-1\u0000call_0';
    const second = 'src-2\u0000call_0';
    pendingApprovals.current = [{ approvalId: 'call_0', threadId: 'main' }];
    const { rerender } = render(tree([message('m1', [call(first, 'pending')], true)]));
    await settle();
    publish('call_0', 'Do a', null, 'src-1');
    expect(screen.getByText('Do a')).toBeInTheDocument();

    const recording = recordFrames();
    pendingApprovals.current = [];
    rerender(tree([message('m1', [call(first, 'approved')], false)]));
    await settle();
    expect(screen.queryByText('Do a')).not.toBeInTheDocument();

    // The second call is pending, but its own card has not been delivered yet.
    pendingApprovals.current = [{ approvalId: 'call_0', threadId: 'main' }];
    rerender(tree([message('m1', [call(first, 'approved'), call(second, 'pending')], true)]));
    await settle();
    expect(screen.queryByText('Do a')).not.toBeInTheDocument();

    publish('call_0', 'Do b', null, 'src-2');
    await settle();
    expect(screen.getByText('Do b')).toBeInTheDocument();
    recording.stop();
    expect(recording.frames.some(text => text.includes('Do a'))).toBe(false);
  });
});
