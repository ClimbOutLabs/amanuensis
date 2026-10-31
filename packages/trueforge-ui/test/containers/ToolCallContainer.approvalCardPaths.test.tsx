// @vitest-environment jsdom
import {
  ThreadPrimitive,
  type ThreadMessage,
  type ThreadMessageLike,
  type ToolCallMessagePart,
} from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApi, SentinelApprovalCard, SentinelApprovalInfo } from '@/sentinel/types.js';
import type { AgentDetailsVisibility } from '@/server/AgentDetailsPreferenceContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { respondToToolApproval, details } = vi.hoisted(() => {
  const details: { visibility: AgentDetailsVisibility } = { visibility: 'collapsed' };
  return { respondToToolApproval: vi.fn(), details };
});

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return { ...actual, useTrueFoundryRespondToToolApproval: () => respondToToolApproval };
});

vi.mock('@/server/AgentDetailsPreferenceContext.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/AgentDetailsPreferenceContext.js')>();
  return {
    ...actual,
    useAgentDetailsVisibility: () => ({ visibility: details.visibility, setVisibility: async () => {} }),
  };
});

/** Invented mail only. */
const DRAFT_ARGS = {
  to: 'robin@example.test',
  subject: 'Picnic plans',
  thread_id: 'thread-0001',
  in_reply_to: '<msg-0001@example.test>',
  body: 'Bring the blue blanket.',
};

const DECLARED_OPTIONS = [
  { id: 'allow-once', kind: 'allow-once' as const },
  { id: 'deny', kind: 'reject-once' as const, confirm: {} },
];

function draftCard(): SentinelApprovalCard {
  return {
    plain_what: 'Save a draft to Robin Example.',
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: 'robin@example.test',
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    email: {
      action: 'save',
      to: [{ name: 'Robin Example', address: 'robin@example.test' }],
      cc: [],
      bcc: [],
      subject: 'Picnic plans',
      body: 'Bring the blue blanket.',
      replaces: null,
      reply_in_thread: { subject: 'Picnic plans', from: 'robin@example.test' },
      reply_to: null,
    },
    calendar_event: null,
    schedule: null,
    persona: null,
  };
}

function draftInfo(toolCallId: string, threadId: string): SentinelApprovalInfo {
  return { toolCallId, tier: 3, card: draftCard(), eventId: 'evt-ask', threadId };
}

/** A `draft_email` call waiting on the person, as a plain tool or wrapped by the connector's `call_tool`. */
function draftCall(toolCallId: string, shape: 'direct' | 'connector'): ToolCallMessagePart {
  const argsText =
    shape === 'direct'
      ? JSON.stringify(DRAFT_ARGS)
      : JSON.stringify({ mcp_server: 'email-mcp', tool_name: 'draft_email', input: DRAFT_ARGS });
  return {
    type: 'tool-call',
    toolCallId,
    toolName: shape === 'direct' ? 'draft_email' : 'call_tool',
    args: {},
    argsText,
    interrupt: { type: 'human', payload: {} },
    approval: { id: toolCallId, approved: undefined, options: DECLARED_OPTIONS },
  };
}

function waitingMessage(content: ThreadMessageLike['content']): ThreadMessageLike {
  return { role: 'assistant', content, status: { type: 'requires-action', reason: 'tool-calls' } };
}

/** A helper agent's step that asks inside the parent's `create_sub_agent` call. */
function subAgentMessage(shape: 'direct' | 'connector'): ThreadMessageLike {
  const nested: ThreadMessage = {
    id: 'nested-1',
    role: 'assistant',
    createdAt: new Date('2026-10-22T09:00:00Z'),
    content: [draftCall('nested-draft', shape)],
    status: { type: 'requires-action', reason: 'tool-calls' },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: { subAgent: { title: 'Mail helper', input: 'Draft the reply' } },
    },
  };
  return waitingMessage([
    { type: 'tool-call', toolCallId: 'helper', toolName: 'create_sub_agent', args: {}, messages: [nested] },
  ]);
}

function sentinelApi(saved: SentinelApprovalInfo[]): SentinelApi {
  const settings = {
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: false,
    maps_without_asking: false,
    sandbox_without_asking: true,
    package_downloads_without_project_allowed: false,
  };
  return {
    listAuditEntries: vi.fn(async () => []),
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings: vi.fn(async () => settings),
    listSentinelSessionContext: vi.fn(async () => ({ approvals: saved })),
    listBriefItemCompletions: vi.fn(async () => []),
    markBriefItemDone: vi.fn(async () => undefined),
    unmarkBriefItemDone: vi.fn(async () => undefined),
  };
}

function renderChat({
  message,
  saved = [],
  sentinel = true,
  onRespondToToolApproval,
}: {
  message: ThreadMessageLike;
  saved?: SentinelApprovalInfo[];
  sentinel?: boolean;
  onRespondToToolApproval?: (options: unknown) => void;
}) {
  const thread = <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>;
  const withSentinel = (children: ReactNode) =>
    sentinel ? (
      <SentinelApiProvider api={sentinelApi(saved)}>
        <SentinelStateProvider>{children}</SentinelStateProvider>
      </SentinelApiProvider>
    ) : (
      children
    );
  return render(
    <SlotsProvider>
      <RuntimeHarness
        messages={[message]}
        threadId="local-1"
        remoteId="session-agent-1"
        onRespondToToolApproval={onRespondToToolApproval}
      >
        {withSentinel(thread)}
      </RuntimeHarness>
    </SlotsProvider>,
  );
}

function expectNoOldCard() {
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByText(/Tool Approval Required/i)).not.toBeInTheDocument();
}

function expectNoRawRequest() {
  expect(screen.queryByTestId('tfy-tool-call-content-block')).not.toBeInTheDocument();
  expect(screen.queryByText('Request')).not.toBeInTheDocument();
  expect(document.body.innerHTML).not.toContain('"in_reply_to"');
}

/** The new generic ticket, waiting, with buttons a person can press. */
async function expectStandInTicket(title: string) {
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled();
  expectNoOldCard();
  expectNoRawRequest();
}

/** The new mail card for a draft: the uniform Allow verb, never the old Save draft verb. */
async function expectDraftCard() {
  expect(await screen.findByRole('button', { name: 'Allow' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  expectNoOldCard();
  expectNoRawRequest();
}

function mockPhone(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

beforeEach(() => {
  details.visibility = 'collapsed';
  mockPhone(false);
});

afterEach(() => {
  clearSentinelEventSubscribers();
  respondToToolApproval.mockClear();
  vi.unstubAllGlobals();
});

describe('every waiting approval uses the new card family', () => {
  it('a custom agent chat: the server card arrives after the first render and replaces the generic ticket', async () => {
    renderChat({ message: waitingMessage([draftCall('call-draft', 'direct')]) });
    await waitFor(() => expect(document.querySelector('[data-role="approval-loading"]')).toBeNull());
    await expectStandInTicket('Allow the assistant to use "draft email"?');

    act(() => publishSentinelEvent(draftInfo('call-draft', 'main')));
    await expectDraftCard();
  });

  it('a custom agent chat whose server card is already saved shows the mail card', async () => {
    renderChat({
      message: waitingMessage([draftCall('call-draft', 'direct')]),
      saved: [draftInfo('call-draft', 'main')],
    });
    await expectDraftCard();
  });

  it('the first render before any card read shows a quiet line, never the old card or raw arguments', () => {
    renderChat({ message: waitingMessage([draftCall('call-draft', 'direct')]) });
    expect(document.querySelector('[data-role="approval-loading"]')).not.toBeNull();
    expectNoOldCard();
    expectNoRawRequest();
  });

  it('a mail connector (MCP) draft with no card yet shows the generic ticket with plain fields', async () => {
    renderChat({ message: waitingMessage([draftCall('call-mcp', 'connector')]) });
    await expectStandInTicket('Allow "draft email" on email-mcp?');
    expect(screen.getByText(/subject: Picnic plans/)).toBeInTheDocument();
  });

  it('a waiting draft with no card yet shows who it goes to, first and open, before any click', async () => {
    renderChat({ message: waitingMessage([draftCall('call-mcp', 'connector')]) });
    await expectStandInTicket('Allow "draft email" on email-mcp?');
    const request = screen.getByText(/to: robin@example\.test/);
    // Fails inside a closed Details section, which a person would have to open first.
    expect(request).toBeVisible();
    expect(request.textContent?.split('\n')[0]).toBe('to: robin@example.test');
    expect(respondToToolApproval).not.toHaveBeenCalled();
  });

  it('a mail connector (MCP) draft with its server card shows the mail card', async () => {
    renderChat({
      message: waitingMessage([draftCall('call-mcp', 'connector')]),
      saved: [draftInfo('call-mcp', 'main')],
    });
    await expectDraftCard();
  });

  it('a built-in mail draft with its server card shows the mail card', async () => {
    renderChat({
      message: waitingMessage([draftCall('call-builtin', 'direct')]),
      saved: [draftInfo('call-builtin', 'main')],
    });
    await expectDraftCard();
  });

  it('a helper agent step with its server card can be answered, and the answer goes to the helper call', async () => {
    renderChat({ message: subAgentMessage('direct'), saved: [draftInfo('nested-draft', 'helper-thread')] });
    await expectDraftCard();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'nested-draft', approved: true, optionId: 'allow-once' }),
    );
  });

  it('a helper agent step with no card yet shows the generic ticket and can be answered', async () => {
    renderChat({ message: subAgentMessage('connector') });
    await expectStandInTicket('Allow "draft email" on email-mcp?');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'nested-draft', approved: false, optionId: 'deny' }),
    );
  });

  for (const visibility of ['expanded', 'collapsed'] as const) {
    it(`agent details ${visibility === 'expanded' ? 'on' : 'off'}: the waiting card is the new one`, async () => {
      details.visibility = visibility;
      renderChat({
        message: waitingMessage([
          { type: 'tool-call', toolCallId: 'done', toolName: 'read_inbox', args: {}, result: 'ok' },
          draftCall('call-draft', 'direct'),
        ]),
      });
      await expectStandInTicket('Allow the assistant to use "draft email"?');
    });
  }

  it('the phone layout shows the new card, not the old one', async () => {
    mockPhone(true);
    renderChat({ message: waitingMessage([draftCall('call-draft', 'connector')]) });
    await expectStandInTicket('Allow "draft email" on email-mcp?');
  });

  it('a host without the approval-card service still shows the generic ticket', async () => {
    const onRespondToToolApproval = vi.fn();
    renderChat({
      message: waitingMessage([draftCall('call-draft', 'direct')]),
      sentinel: false,
      onRespondToToolApproval,
    });
    await expectStandInTicket('Allow the assistant to use "draft email"?');
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'call-draft', approved: true, optionId: 'allow-once' }),
    );
  });
});
