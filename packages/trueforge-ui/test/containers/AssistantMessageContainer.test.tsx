// @vitest-environment jsdom
import { ThreadPrimitive, type RespondToToolApprovalOptions, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRecallProvider } from '@/components/MemoryRecallContext.js';
import { ModelUsageProvider, type ModelUsageTurnContext } from '@/components/ModelUsageContext.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { MemoryTurnContextProvider } from '@/containers/MemoryTurnContextProvider.js';
import { ModelUsageTurnProvider } from '@/containers/ModelUsageTurnProvider.js';
import { resetWaitQueueTurnClocks } from '@/hooks/useWaitQueue.js';
import { AgentDetailsPreferenceProvider } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { setModelUsageVisible } from '@/utils/modelUsageDisplayPreference.js';
import { NANO_COMPACTION_EVENT, NANO_SUMMARY_EVENT, SUPER_EVENT } from '../fixtures/modelUsageEvents.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

// The orb draws on a 2d canvas context, which jsdom does not implement; stub
// it like the WaitQueueIndicator suite does. The queue's stations, microcopy,
// and clock — what these tests assert — are unaffected.
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

// Stub the real MapCard (its Leaflet setup is covered in MapCard.test.tsx);
// these tests assert where the maps result renders, not how the map draws.
vi.mock('@/components/MapCard.js', () => ({
  MapCard: ({ data }: { data: { resolved_name: string } | null }) => (
    <div data-testid="mock-map-card">{data?.resolved_name ?? 'no data'}</div>
  ),
}));

function assistantMessageTree(
  messages: ThreadMessageLike[],
  options?: { isRunning?: boolean; onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void },
) {
  return (
    <RuntimeHarness
      messages={messages}
      isRunning={options?.isRunning}
      onRespondToToolApproval={options?.onRespondToToolApproval}
    >
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>
  );
}

function renderAssistantMessage(
  messages: ThreadMessageLike[],
  options?: { isRunning?: boolean; onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void },
) {
  return render(assistantMessageTree(messages, options));
}

function getAgentInternals(): HTMLElement {
  const disclosure = screen.getByTestId('assistant-message-agent-internals');
  if (!(disclosure instanceof HTMLElement)) throw new Error('Expected an agent internals disclosure');
  return disclosure;
}

function erroredToolCallMessage(): ThreadMessageLike {
  return {
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
  };
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

  it('copies the answer through the fallback over plain http, where navigator.clipboard is missing', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      renderAssistantMessage([{ role: 'assistant', content: 'done', createdAt: new Date('2026-07-09T14:06:04') }], {
        isRunning: false,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(exec).toHaveBeenCalledWith('copy');
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    }
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
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
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
    expect(card.getByRole('radio', { name: 'Approve' })).toBeVisible();
    expect(card.getByRole('radio', { name: 'Deny' })).toBeVisible();
    fireEvent.click(card.getByRole('radio', { name: 'Approve' }));
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

  describe('answer text written before a tool call', () => {
    const SUMMARY = 'The PDF covers three topics: pricing, onboarding, and the support model, with details for each.';
    const toolCall = {
      type: 'tool-call' as const,
      toolCallId: 'tool-search',
      toolName: 'web_search',
      args: {},
      argsText: '{}',
      result: { ok: true },
    };

    it('keeps substantive text outside the collapsed internals, in order', () => {
      renderAssistantMessage([
        {
          role: 'assistant',
          content: [{ type: 'text', text: SUMMARY }, toolCall, { type: 'text', text: 'Confirmed.' }],
        },
      ]);

      const summary = screen.getByText(SUMMARY);
      const internals = getAgentInternals();
      const confirmed = screen.getByText('Confirmed.');
      expect(summary.closest('[hidden]')).toBeNull();
      expect(internals).toHaveTextContent(/1 step · 1 tool/);
      expect(internals.querySelector('[hidden]')).not.toBeNull();
      expect(summary.compareDocumentPosition(internals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(internals.compareDocumentPosition(confirmed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps short text before a tool call visible', () => {
      renderAssistantMessage([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search for that.' },
            toolCall,
            { type: 'text', text: 'Here you go.' },
          ],
        },
      ]);

      expect(screen.getByText('Let me search for that.').closest('[hidden]')).toBeNull();
      expect(screen.getByText('Here you go.').closest('[hidden]')).toBeNull();
      expect(getAgentInternals().querySelector('[hidden]')).not.toBeNull();
    });

    it('shows the sentence before a run_code call and the result after it', () => {
      renderAssistantMessage([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll run that calculation for you." },
            { ...toolCall, toolCallId: 'tool-run', toolName: 'run_code' },
            { type: 'text', text: 'The result is **20**.' },
          ],
        },
      ]);

      expect(screen.getByText("I'll run that calculation for you.").closest('[hidden]')).toBeNull();
      expect(screen.getByText('20').closest('[hidden]')).toBeNull();
    });

    it('shows the sentence before an undecided approval while the turn waits', () => {
      renderAssistantMessage([
        {
          role: 'assistant',
          status: { type: 'requires-action', reason: 'tool-calls' },
          content: [
            { type: 'text', text: "I'll run that calculation for you." },
            {
              type: 'tool-call',
              toolCallId: 'tool-run',
              toolName: 'run_code',
              args: { language: 'python', code: 'print(4 * 5)' },
              argsText: '{"language":"python","code":"print(4 * 5)"}',
              interrupt: { type: 'human', payload: {} },
              approval: {
                id: 'approval-run',
                options: [
                  { id: 'allow-once', kind: 'allow-once' },
                  { id: 'deny', kind: 'reject-once' },
                ],
              },
            },
          ],
        },
      ]);

      expect(screen.getByText("I'll run that calculation for you.").closest('[hidden]')).toBeNull();
      expect(getAgentInternals()).toHaveTextContent(/Waiting for approval/);
    });

    it('shows the answer after a tool call while the message is still running', async () => {
      renderAssistantMessage(
        [
          {
            role: 'assistant',
            status: { type: 'running' },
            content: [toolCall, { type: 'text', text: 'The result is 2' }],
          },
        ],
        { isRunning: true },
      );

      expect((await screen.findByText('The result is 2')).closest('[hidden]')).toBeNull();
    });

    it('renders one disclosure per folded run with its own counts', () => {
      renderAssistantMessage([
        {
          role: 'assistant',
          content: [
            toolCall,
            { type: 'text', text: SUMMARY },
            { ...toolCall, toolCallId: 'tool-2' },
            { ...toolCall, toolCallId: 'tool-3' },
            { type: 'text', text: 'Done.' },
          ],
        },
      ]);

      const disclosures = screen.getAllByTestId('assistant-message-agent-internals');
      expect(disclosures).toHaveLength(2);
      expect(disclosures[0]).toHaveTextContent(/1 step · 1 tool/);
      expect(disclosures[1]).toHaveTextContent(/2 steps · 2 tools/);
      expect(screen.getByText(SUMMARY).closest('[hidden]')).toBeNull();
    });
  });

  it('collapses the content but keeps the attention dot when a completed turn has a tool error', () => {
    renderAssistantMessage([erroredToolCallMessage()]);

    const internals = getAgentInternals();
    expect(internals).toHaveTextContent(/1 step · 1 tool/);
    expect(internals.querySelector('[hidden]')).not.toBeNull();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
  });

  it('auto-expands the internals of a running turn when a tool errored', () => {
    renderAssistantMessage([{ ...erroredToolCallMessage(), status: { type: 'running' } }], { isRunning: true });

    const internals = getAgentInternals();
    expect(internals.querySelector('[hidden]')).toBeNull();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
  });

  it('reveals a completed errored turn when the stored agent-details preference is expanded', async () => {
    const session = {
      id: 'sess-1',
      isMutable: true,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      metadata: { agent_details: 'expanded' },
    };
    const server = createMockAgentUIServer({
      getSession: vi.fn(async () => session),
      updateSession: vi.fn(async () => session),
    });

    render(
      <ServerProvider server={server}>
        <AgentDetailsPreferenceProvider>
          <RuntimeHarness messages={[erroredToolCallMessage()]} threadId="t1" remoteId="sess-1">
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </RuntimeHarness>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>,
    );
    // Let the stored session preference resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const internals = getAgentInternals();
    expect(internals.querySelector('[hidden]')).toBeNull();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
  });
});

describe('AssistantMessageContainer images without a chat image scope', () => {
  const DATA_PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('shows a model data: image as not shown when the turn has no session id', () => {
    const server = Object.assign(createMockAgentUIServer(), {
      chatImages: {
        listTurnImages: vi.fn(() => Promise.resolve({ artifacts: [], emails: [] })),
        showTurnImages: vi.fn(() => Promise.resolve({ status: 'done' as const, images: [] })),
        imageUrl: ({ sessionId, imageId }: { sessionId: string; imageId: string }) =>
          `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
      },
    });
    const { container } = render(
      <ServerProvider server={server}>
        {assistantMessageTree([
          { role: 'assistant', content: `Here: ![model pixel](${DATA_PNG})`, metadata: { custom: { turnId: 't1' } } },
        ])}
      </ServerProvider>,
    );
    expect(container.querySelector(`img[src="${DATA_PNG}"]`)).toBeNull();
    expect(screen.getByTestId('aui-chat-image-not-shown')).toHaveTextContent('model pixel (image not shown)');
  });

  it('shows a model data: image as not shown when there is no chat images port', () => {
    const { container } = renderAssistantMessage([{ role: 'assistant', content: `![x](${DATA_PNG})` }]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('aui-chat-image-not-shown')).toBeInTheDocument();
  });
});

describe('AssistantMessageContainer memory recall visibility', () => {
  const recallEvent: TrueForgeApi.MemoryRecallPersistedEvent = {
    type: 'aman.memory.recall',
    id: 'evt_recall_1',
    createdAt: '2026-08-03T00:00:00.000Z',
    injectedBlock: '<aman-memory>recalled fact</aman-memory>',
    stats: {
      items: 3,
      entities: 1,
      droppedOverBudget: 0,
      droppedBelowThreshold: 0,
      estimatedTokens: 42,
      recallMs: 17,
      budgetReason: 'normal',
      outcome: 'ok',
    },
    sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
  };

  const messages: ThreadMessageLike[] = [
    {
      role: 'assistant',
      content: 'here you go',
      metadata: { custom: { turnId: 'trn_1' } },
    },
  ];

  async function renderWithStoredPreference(options: {
    agentDetails: 'expanded' | 'collapsed';
    recallOutcome?: 'ok' | 'timeout' | 'error';
  }) {
    const { agentDetails, recallOutcome = 'ok' } = options;
    const session = {
      id: 'sess-1',
      isMutable: true,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      metadata: { agent_details: agentDetails },
    };
    const server = createMockAgentUIServer({
      getSession: vi.fn(async () => session),
      updateSession: vi.fn(async () => session),
    });
    const recall: TrueForgeApi.MemoryRecallPersistedEvent = {
      ...recallEvent,
      stats: { ...recallEvent.stats, outcome: recallOutcome },
    };
    const listMemoryTurnContext = vi.fn(async () => [{ turnId: 'trn_1', recall }]);

    const result = render(
      <ServerProvider server={server}>
        <AgentDetailsPreferenceProvider>
          <MemoryRecallProvider api={{ listMemoryTurnContext }}>
            <RuntimeHarness messages={messages} threadId="t1" remoteId="sess-1">
              <MemoryTurnContextProvider>
                <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
              </MemoryTurnContextProvider>
            </RuntimeHarness>
          </MemoryRecallProvider>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>,
    );
    // Let the session preference and memory context both resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  }

  it('shows the "N recalled" segment and recall counts when agent details are expanded', async () => {
    await renderWithStoredPreference({ agentDetails: 'expanded' });
    const internals = getAgentInternals();
    expect(within(internals).getByText(/3 recalled/)).toBeInTheDocument();
    expect(within(internals).getByText('3 items, 1 entity')).toBeInTheDocument();
  });

  it('hides the "N recalled" segment and recall counts when agent details are collapsed', async () => {
    await renderWithStoredPreference({ agentDetails: 'collapsed' });
    expect(screen.queryByText(/recalled/)).not.toBeInTheDocument();
    expect(screen.queryByText('Recalled memory')).not.toBeInTheDocument();
  });

  it('keeps the attention dot and the recall count in the summary when a completed recall errored', async () => {
    await renderWithStoredPreference({ agentDetails: 'collapsed', recallOutcome: 'error' });

    const internals = getAgentInternals();
    // The failed recall still surfaces in the summary row next to the amber dot…
    expect(within(internals).getByText(/3 recalled/)).toBeInTheDocument();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
    // …while the disclosure content itself collapses on the completed turn.
    expect(internals.querySelector('[hidden]')).not.toBeNull();
  });

  it('shows the attention dot with collapsed content when the memory context fetch failed', async () => {
    const session = {
      id: 'sess-1',
      isMutable: true,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      metadata: { agent_details: 'collapsed' },
    };
    const server = createMockAgentUIServer({
      getSession: vi.fn(async () => session),
      updateSession: vi.fn(async () => session),
    });
    const listMemoryTurnContext = vi.fn(async () => {
      throw new Error('memory fetch failed');
    });

    render(
      <ServerProvider server={server}>
        <AgentDetailsPreferenceProvider>
          <MemoryRecallProvider api={{ listMemoryTurnContext }}>
            <RuntimeHarness messages={messages} threadId="t1" remoteId="sess-1">
              <MemoryTurnContextProvider>
                <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
              </MemoryTurnContextProvider>
            </RuntimeHarness>
          </MemoryRecallProvider>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>,
    );
    // Let the session preference and the failed memory fetch both resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const internals = getAgentInternals();
    expect(screen.getByTestId('assistant-message-agent-internals-attention')).toBeInTheDocument();
    expect(internals.querySelector('[hidden]')).not.toBeNull();
  });
});

describe('AssistantMessageContainer wait queue (production path)', () => {
  // These tests render the real AssistantMessageContainer — including its
  // MessagePrimitive.GroupedParts wiring — rather than mounting the hook or
  // the indicator in isolation. Mounting those directly bypasses the
  // GroupedParts `indicator` gate, which is how the suite stayed green while
  // production flickered.
  const TURN_ID = 'turn-wait-queue';

  beforeEach(() => {
    // The per-turn clock lives in module state so it survives remounts; clear
    // it so one test's turn can never resume another's clock.
    resetWaitQueueTurnClocks();
  });

  function turnMessages(content: ThreadMessageLike['content']): ThreadMessageLike[] {
    return [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        id: TURN_ID,
        content,
        metadata: { custom: { turnId: TURN_ID } },
      },
    ];
  }

  function turnTree(mountKey: string, content: ThreadMessageLike['content']) {
    return (
      <RuntimeHarness key={mountKey} messages={turnMessages(content)} isRunning>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </RuntimeHarness>
    );
  }

  function queueRoot(): Element | null {
    return document.querySelector('.aui-wait-queue');
  }

  it('keeps the wait queue mounted while the first tokens stream', () => {
    render(turnTree('mount-1', 'hello there'));

    // With the GroupedParts default indicator mode ("no-text") the queue
    // unmounts the moment text lands; the production container opts into
    // indicator="always" so the queue survives streaming.
    expect(queueRoot()).not.toBeNull();
  });

  it('lights the Writing station when the first tokens stream', () => {
    render(turnTree('mount-1', 'hello there'));

    const writingLabel = document.querySelector('.aui-wait-queue__station--active .aui-wait-queue__label');
    expect(writingLabel).toHaveTextContent('Writing');
    expect(document.querySelector('.aui-wait-queue__station--arriving')).not.toBeNull();
  });

  it('keeps one elapsed clock across a text→tool→text turn with remounts', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-21T19:00:00.000Z'));
      const toolContent: ThreadMessageLike['content'] = [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: {}, argsText: '{}' },
      ];

      const { rerender } = render(turnTree('phase-text-1', 'first tokens'));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      // Text → tool phase. The mount-key change forces a full remount, like
      // the indicator unmount/remount production shows across turn phases; a
      // per-mount clock would restart here.
      rerender(turnTree('phase-tool', toolContent));
      act(() => {
        vi.advanceTimersByTime(6_000);
      });

      // 16s into the same turn: the long-wait note must carry the turn's
      // clock, not the 6s since the remount.
      const longWait = document.querySelector('.aui-wait-queue__longwait');
      expect(longWait).not.toBeNull();
      expect(longWait?.textContent).toMatch(/16s so far/);

      // …and back to text: still the same turn clock.
      rerender(turnTree('phase-text-2', 'more tokens'));
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(document.querySelector('.aui-wait-queue__longwait')?.textContent).toMatch(/18s so far/);
    } finally {
      vi.useRealTimers();
    }
  });

  type ToolCallPart = Extract<Exclude<ThreadMessageLike['content'], string>[number], { type: 'tool-call' }>;

  function mapsCallPart(extra: Pick<ToolCallPart, 'toolCallId'> & Partial<Pick<ToolCallPart, 'result' | 'approval'>>) {
    return {
      type: 'tool-call',
      toolName: 'render_map',
      args: { place_name: 'Paris' },
      argsText: '{"place_name":"Paris"}',
      ...extra,
    } satisfies ToolCallPart;
  }

  it('renders a completed maps result inline, outside the agent internals', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          mapsCallPart({
            toolCallId: 'tool-map-1',
            result: JSON.stringify({
              status: 'ok',
              resolved_name: 'Paris, France',
              address: 'Paris, France',
              lat: 48.8566,
              lng: 2.3522,
              zoom: 13,
              pins: [],
              attribution: '© OpenStreetMap contributors',
            }),
          }),
          { type: 'text', text: 'Here is the map of Paris.' },
        ],
      },
    ]);

    // The map call is not folded into agent details, so the turn has no internals row at all.
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    // It renders inline in the conversation, before the assistant text.
    const mapCard = screen.getByTestId('mock-map-card');
    expect(mapCard).toHaveTextContent('Paris, France');
    const text = screen.getByText('Here is the map of Paris.');
    expect(mapCard.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows only the approval card for a maps call awaiting approval', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          mapsCallPart({
            toolCallId: 'tool-map-approval',
            approval: {
              id: 'approval-map',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          }),
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
    ]);

    // The approval card sits inline with the call, not behind a collapsed disclosure.
    expect(screen.getByRole('radiogroup', { name: 'Approval options for render_map' })).toBeInTheDocument();
    // No map card and no loading state anywhere while approval is pending.
    expect(screen.queryByTestId('mock-map-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-card-loading')).not.toBeInTheDocument();
  });

  function placesCallPart(
    extra: Pick<ToolCallPart, 'toolCallId'> & Partial<Pick<ToolCallPart, 'result' | 'approval'>>,
  ) {
    return {
      type: 'tool-call',
      toolName: 'render_places',
      args: { places: [] },
      argsText: '{"places":[]}',
      ...extra,
    } satisfies ToolCallPart;
  }

  it('renders the pinned places inline once the pin call has run', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          placesCallPart({
            toolCallId: 'tool-places-1',
            result: JSON.stringify({
              status: 'ok',
              places: [
                {
                  name: 'Harbour Family Clinic',
                  address: '12 Example Street, Lisbon 1100-000',
                  languages: 'English, Portuguese',
                  hours: null,
                  price: null,
                  phone: null,
                  source_url: 'https://harbour-clinic.example/en',
                  source_site: 'harbour-clinic.example',
                  fetched_at: '2026-10-17T10:00:00.000Z',
                  lat: 38.7,
                  lng: -9.1,
                  already_in_calendar: false,
                },
              ],
              refused: [],
              attribution: '© OpenStreetMap contributors',
            }),
          }),
          { type: 'text', text: 'I found one place.' },
        ],
      },
    ]);

    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-map-card')).toHaveTextContent('1 place found');
  });

  it('asks first for the pin call and shows no map until it is approved', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          placesCallPart({
            toolCallId: 'tool-places-approval',
            approval: {
              id: 'approval-places',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          }),
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
    ]);

    expect(screen.getByRole('radiogroup', { name: 'Approval options for render_places' })).toBeInTheDocument();
    expect(screen.queryByTestId('mock-map-card')).not.toBeInTheDocument();
  });

  it('shows a quiet loading state while the maps call runs', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [mapsCallPart({ toolCallId: 'tool-map-running' })],
        status: { type: 'running' },
      },
    ]);

    expect(screen.getByTestId('map-card-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-map-card')).not.toBeInTheDocument();
  });

  it('expires the approval card of a maps call once the chat has moved on', () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: [
          mapsCallPart({
            toolCallId: 'tool-map-old',
            approval: {
              id: 'approval-map-old',
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'deny', kind: 'reject-once' },
              ],
            },
          }),
        ],
        status: { type: 'requires-action', reason: 'tool-calls' },
      },
      { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Okay.' }] },
    ]);

    expect(screen.getByText('This request expired.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Approval options for render_map' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-card-loading')).not.toBeInTheDocument();
  });
});

describe('AssistantMessageContainer model and cost line', () => {
  const messages: ThreadMessageLike[] = [
    { role: 'assistant', content: 'here you go', metadata: { custom: { turnId: 'trn_1' } } },
  ];

  beforeEach(() => {
    setModelUsageVisible(true);
  });

  async function renderWithUsage(options: {
    usage: ModelUsageTurnContext[];
    agentDetails?: 'expanded' | 'collapsed';
    isRunning?: boolean;
    threadMessages?: ThreadMessageLike[];
  }) {
    const { usage, agentDetails = 'collapsed', isRunning = false, threadMessages = messages } = options;
    const session = {
      id: 'sess-1',
      isMutable: true,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
      metadata: { agent_details: agentDetails },
    };
    const server = createMockAgentUIServer({
      getSession: vi.fn(async () => session),
      updateSession: vi.fn(async () => session),
    });
    const listModelUsage = vi.fn(async () => usage);

    const result = render(
      <ServerProvider server={server}>
        <AgentDetailsPreferenceProvider>
          <ModelUsageProvider api={{ listModelUsage }}>
            <RuntimeHarness messages={threadMessages} threadId="t1" remoteId="sess-1" isRunning={isRunning}>
              <ModelUsageTurnProvider>
                <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
              </ModelUsageTurnProvider>
            </RuntimeHarness>
          </ModelUsageProvider>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return { ...result, listModelUsage };
  }

  it('shows the model, provider, tokens and cost of the turn under the answer', async () => {
    await renderWithUsage({ usage: [{ turnId: 'trn_1', events: [SUPER_EVENT] }] });

    expect(screen.getByTestId('model-usage-line')).toHaveTextContent(
      'Nemotron 3 Super · Token Factory · 2,140 tokens (1,800 in, 340 out) · $0.0008',
    );
  });

  it('folds helper calls into the total and names the model they ran on', async () => {
    await renderWithUsage({
      usage: [{ turnId: 'trn_1', events: [SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT] }],
    });

    expect(screen.getByTestId('model-usage-line')).toHaveTextContent('6,990 tokens');
    expect(screen.getByTestId('model-usage-helpers')).toHaveTextContent('+ 2 helper calls on Nemotron 3 Nano');
  });

  it('lists the helper calls with their model, tokens and cost in the agent details when they are on', async () => {
    await renderWithUsage({
      usage: [{ turnId: 'trn_1', events: [SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT] }],
      agentDetails: 'expanded',
    });

    const internals = getAgentInternals();
    expect(within(internals).getByText(/2 helper calls/)).toBeInTheDocument();
    const rows = within(internals).getAllByTestId('model-usage-row');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Answer·Nemotron 3 Super'),
      expect.stringContaining('Memory summary'),
      expect.stringContaining('Compaction'),
    ]);
    expect(rows[2]).toHaveTextContent('4,300 tokens (4,000 in, 300 out) · $0.0003');
  });

  it('keeps the helper rows out of the details while agent details are off, leaving the line', async () => {
    await renderWithUsage({
      usage: [{ turnId: 'trn_1', events: [SUPER_EVENT, NANO_SUMMARY_EVENT] }],
      agentDetails: 'collapsed',
    });

    expect(screen.queryByTestId('model-usage-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-usage-helpers')).toBeInTheDocument();
  });

  it('adds no details row for a turn that had only its answer', async () => {
    await renderWithUsage({ usage: [{ turnId: 'trn_1', events: [SUPER_EVENT] }], agentDetails: 'expanded' });

    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
  });

  it('says usage was not reported when the provider reported none', async () => {
    await renderWithUsage({
      usage: [
        {
          turnId: 'trn_1',
          events: [{ ...SUPER_EVENT, reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null }],
        },
      ],
    });

    expect(screen.getByTestId('model-usage-line')).toHaveTextContent(
      'Nemotron 3 Super · Token Factory · usage not reported',
    );
  });

  it('shows nothing for a turn with no recorded usage', async () => {
    await renderWithUsage({ usage: [{ turnId: 'trn_other', events: [SUPER_EVENT] }] });

    expect(screen.queryByTestId('model-usage-line')).not.toBeInTheDocument();
  });

  it('hides the line and the helper rows when the display switch is off', async () => {
    setModelUsageVisible(false);
    await renderWithUsage({
      usage: [{ turnId: 'trn_1', events: [SUPER_EVENT, NANO_SUMMARY_EVENT] }],
      agentDetails: 'expanded',
    });

    expect(screen.queryByTestId('model-usage-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-usage-row')).not.toBeInTheDocument();
  });

  it('does not draw the line while the turn is still running', async () => {
    await renderWithUsage({
      usage: [{ turnId: 'trn_1', events: [SUPER_EVENT] }],
      isRunning: true,
      threadMessages: [
        {
          role: 'assistant',
          content: 'here you go',
          status: { type: 'running' },
          metadata: { custom: { turnId: 'trn_1' } },
        },
      ],
    });

    expect(screen.queryByTestId('model-usage-line')).not.toBeInTheDocument();
  });

  it('draws no line without a host usage provider', async () => {
    render(
      <RuntimeHarness messages={messages} threadId="t1" remoteId="sess-1">
        <ModelUsageTurnProvider>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </ModelUsageTurnProvider>
      </RuntimeHarness>,
    );

    expect(screen.queryByTestId('model-usage-line')).not.toBeInTheDocument();
  });
});
