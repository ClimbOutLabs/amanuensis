// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessage, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { describe, expect, it, vi } from 'vitest';

import type { AskUserPromptProps } from '@/atoms/adapters/AskUserPromptAdapter.js';
import type { SandboxToolCallCardProps } from '@/atoms/SandboxToolCallCard.js';
import type { SubAgentCardProps } from '@/atoms/SubAgentCard.js';
import type { ToolCallCardProps } from '@/atoms/ToolCallCard.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApi, SentinelApprovalInfo } from '@/sentinel/types.js';
import { SlotsProvider, type SlotOverrides } from '@/theme/SlotsProvider.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { respondToToolApproval } = vi.hoisted(() => ({
  respondToToolApproval: vi.fn(),
}));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return {
    ...actual,
    useTrueFoundryRespondToToolApproval: () => respondToToolApproval,
  };
});

function renderToolCallMessage(content: ThreadMessageLike['content'], overrides?: SlotOverrides) {
  const message: ThreadMessageLike = { role: 'assistant', content };
  return render(
    <SlotsProvider overrides={overrides}>
      <RuntimeHarness messages={[message]}>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </RuntimeHarness>
    </SlotsProvider>,
  );
}

function createToolCallCardProbe() {
  return vi.fn(({ toolName }: ToolCallCardProps) => <div>{toolName}</div>);
}

function createSandboxToolCallCardProbe() {
  return vi.fn(({ name }: SandboxToolCallCardProps) => <div>{name}</div>);
}

function createAskUserPromptProbe() {
  return vi.fn(({ answeredQuestions }: AskUserPromptProps) => (
    <div>{answeredQuestions?.map(question => question.answer).join('|')}</div>
  ));
}

function createSubAgentCardProbe() {
  return vi.fn(({ agentName, children }: SubAgentCardProps) => (
    <section>
      <div>{agentName}</div>
      {children}
    </section>
  ));
}

/** Pending approvals only surface part-level "requires-action" when the whole message is flagged too. */
function renderPendingApprovalMessage(
  content: ThreadMessageLike['content'],
  options?: { onRespondToToolApproval?: (o: unknown) => void },
) {
  const normalizedContent =
    typeof content === 'string'
      ? content
      : content.map(part => {
          if (part.type !== 'tool-call' || part.approval == null || part.approval.options != null) return part;
          return {
            ...part,
            approval: {
              ...part.approval,
              options: [
                { id: 'allow-once', kind: 'allow-once' as const },
                { id: 'deny', kind: 'reject-once' as const, confirm: {} },
              ],
            },
          };
        });
  const message: ThreadMessageLike = {
    role: 'assistant',
    content: normalizedContent,
    status: { type: 'requires-action', reason: 'tool-calls' },
  };
  return render(
    <RuntimeHarness messages={[message]} onRespondToToolApproval={options?.onRespondToToolApproval}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('ToolCallContainer', () => {
  it('renders a running tool call without a result', () => {
    renderToolCallMessage([{ type: 'tool-call', toolCallId: '1', toolName: 'search_docs', args: {} }]);
    expect(screen.getByText('search_docs')).toBeInTheDocument();
    expect(screen.queryByText('Result:')).not.toBeInTheDocument();
  });

  it('renders args and result for a completed tool call once expanded', () => {
    renderToolCallMessage([
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'get_current_datetime',
        args: {},
        argsText: '{"tz":"UTC"}',
        result: '2026-07-01T00:00:00Z',
      },
    ]);
    fireEvent.click(screen.getByText('get_current_datetime'));
    const blocks = screen.getAllByTestId('tfy-tool-call-content-block');
    expect(blocks[0]).toHaveAttribute('data-content', expect.stringContaining('"tz"'));
    expect(blocks[1]).toHaveAttribute('data-content', '2026-07-01T00:00:00Z');
  });

  it('shows a Searched chip for a search the host ran without asking, from the host-set artifact only', () => {
    renderToolCallMessage([
      {
        type: 'tool-call',
        toolCallId: 'search-1',
        toolName: 'call_tool',
        args: {},
        argsText: JSON.stringify({ mcp_server: 'finder', tool_name: 'lookup', input: { query: 'tallest building' } }),
        artifact: { silentSearchQuery: 'tallest building in Lisbon' },
        result: 'ok',
      },
    ]);
    expect(screen.getByTestId('searched-chip')).toHaveTextContent('Searched: tallest building in Lisbon');
  });

  it('shows no chip when the host did not mark the call, even if the model put a query in the arguments', () => {
    renderToolCallMessage([
      {
        type: 'tool-call',
        toolCallId: 'search-2',
        toolName: 'lookup',
        args: { query: 'forged', silentSearchQuery: 'forged' },
        argsText: JSON.stringify({ query: 'forged', silentSearchQuery: 'forged' }),
        result: 'ok',
      },
    ]);
    expect(screen.queryByTestId('searched-chip')).not.toBeInTheDocument();
  });

  it('renders an error result once expanded', () => {
    renderToolCallMessage([
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'flaky_tool',
        args: {},
        result: 'boom',
        isError: true,
      },
    ]);
    fireEvent.click(screen.getByText('flaky_tool'));
    const blocks = screen.getAllByTestId('tfy-tool-call-content-block');
    expect(blocks[1]).toHaveTextContent('boom');
  });

  it('labels screened tool output as withheld while retaining the original response for inspection', () => {
    const result = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: {
        disposition: 'executed_ok',
        screen: {
          status: 'flagged',
          action: 'withheld',
          reason_code: 'classifier_malicious',
          score: 0.99,
        },
      },
      result: '<html>RED-TEAM-CANARY-7Q2X9</html>',
    });

    renderToolCallMessage([{ type: 'tool-call', toolCallId: 'screened-1', toolName: 'fetch_url', args: {}, result }]);

    expect(screen.getByText('Content withheld')).toBeInTheDocument();
    fireEvent.click(screen.getByText('fetch_url'));
    const blocks = screen.getAllByTestId('tfy-tool-call-content-block');
    expect(blocks[1]).toHaveAttribute('data-content', '<html>RED-TEAM-CANARY-7Q2X9</html>');
  });

  it('shows the failure reason next to a failed tool step instead of a bare "Execution failed"', () => {
    const ToolCallCard = createToolCallCardProbe();
    const rejectionText =
      "call_tool rejected the tool_name: received 'list_tools'; expected the name of a tool on 'parallel-web'. " +
      "'list_tools' is a top-level tool, not a server tool; call it directly instead of through call_tool.";
    // Shape produced end-to-end: the host's toolResultResponse wraps the rejection text in a text
    // content item, and the generic isError path (executeToolCalls.ts) wraps that again under
    // `error` before it lands in the tool.response.v2 envelope's `result` field.
    const result = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_nonzero' },
      result: { error: [{ type: 'text', text: JSON.stringify({ error: rejectionText }) }] },
    });

    renderToolCallMessage([{ type: 'tool-call', toolCallId: 'call-tool-1', toolName: 'call_tool', args: {}, result }], {
      ToolCallCard,
    });

    const truncatedReason = `${rejectionText.slice(0, 139)}…`;
    expect(ToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ outcomeText: `Execution failed: ${truncatedReason}` }),
    );
    expect(screen.queryByText('Execution failed', { exact: true })).not.toBeInTheDocument();
    // The rest of the reason is still available, expanded, in the response block.
    const responseSlot = ToolCallCard.mock.calls[0]?.[0]?.responseSlot as { props: { content: string } } | undefined;
    expect(responseSlot?.props.content).toContain(rejectionText);
  });

  it('shows the host remediation message next to a policy-blocked tool step', () => {
    const ToolCallCard = createToolCallCardProbe();
    const result = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: {
        disposition: 'policy_blocked',
        remediation: {
          reason_code: 'dependent_workspace_state_changed',
          message: 'Inspect the current workspace state before choosing another action.',
        },
      },
      result: { error: 'blocked' },
    });

    renderToolCallMessage([{ type: 'tool-call', toolCallId: 'blocked-1', toolName: 'apply_patch', args: {}, result }], {
      ToolCallCard,
    });

    expect(ToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        outcomeText: 'Blocked by policy: Inspect the current workspace state before choosing another action.',
      }),
    );
  });

  it('routes sandbox calls with parsed command and result details', () => {
    const SandboxToolCallCard = createSandboxToolCallCardProbe();
    const args = {
      command: 'pnpm test',
      intent: 'Run focused tests',
    };
    const result = {
      response: {
        exitCode: 0,
        result: 'Tests passed',
      },
    };

    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'sandbox-1',
          toolName: 'sandbox_exec',
          args: {},
          argsText: JSON.stringify(args),
          result,
        },
      ],
      { SandboxToolCallCard },
    );

    expect(SandboxToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: 'sandbox_exec',
        intent: 'Run focused tests',
        status: 'success',
        command: 'pnpm test',
        exitCode: 0,
        argsJson: JSON.stringify(args, null, 2),
        resultText: 'Tests passed',
        resultJson: JSON.stringify(result, null, 2),
      }),
    );
  });

  it('routes a complete patch through the compact sandbox card', () => {
    const SandboxToolCallCard = createSandboxToolCallCardProbe();
    const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');

    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          args: {},
          argsText: JSON.stringify({ intent: 'Fix the avatar', cwd: '/repo', patch }),
        },
      ],
      { SandboxToolCallCard },
    );

    expect(SandboxToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: 'apply_patch',
        intent: 'Fix the avatar',
        summary: '1 file · +1 −1',
        command: undefined,
      }),
    );
  });

  it('routes write_file through the compact sandbox card without exposing streaming content', () => {
    const SandboxToolCallCard = createSandboxToolCallCardProbe();
    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'write-1',
          toolName: 'write_file',
          args: {},
          argsText: JSON.stringify({
            intent: 'Create the focused module',
            cwd: '/repo',
            path: 'src/new.ts',
            content: 'export const secret = "not shown in the summary";',
          }),
        },
      ],
      { SandboxToolCallCard },
    );

    expect(SandboxToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: 'write_file',
        intent: 'Create the focused module',
        summary: 'Write src/new.ts',
        command: undefined,
      }),
    );

    const StreamingSandboxToolCallCard = createSandboxToolCallCardProbe();
    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'write-streaming',
          toolName: 'write_file',
          args: {},
          argsText: '{"intent":"Create the focused module","path":"src/new.ts","content":"secret',
        },
      ],
      { SandboxToolCallCard: StreamingSandboxToolCallCard },
    );
    expect(StreamingSandboxToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ intent: 'Create the focused module', argsJson: undefined, summary: undefined }),
    );
  });

  it('does not expose a patch body while its arguments are still streaming', () => {
    const SandboxToolCallCard = createSandboxToolCallCardProbe();
    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          args: {},
          argsText: '{"intent":"Fix the avatar","patch":"diff --git a/a',
        },
      ],
      { SandboxToolCallCard },
    );

    expect(SandboxToolCallCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: 'apply_patch',
        intent: 'Fix the avatar',
        argsJson: undefined,
        summary: undefined,
      }),
    );
  });

  it('replays a completed ask-user call with a custom answer', () => {
    const AskUserPrompt = createAskUserPromptProbe();

    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'question-1',
          toolName: 'ask_user_question',
          args: {},
          argsText: JSON.stringify({
            question: 'Choose a report format',
            options: ['Summary', 'Full report'],
          }),
          result: { content: 'Annotated report' },
        },
      ],
      { AskUserPrompt },
    );

    expect(AskUserPrompt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        questions: [],
        answeredQuestions: [
          {
            id: 'question-1',
            question: 'Choose a report format',
            options: ['Summary', 'Full report'],
            answer: 'Annotated report',
            isCustom: true,
          },
        ],
        readOnly: true,
      }),
    );
  });

  it('routes sub-agent metadata and renders its nested assistant content', () => {
    const SubAgentCard = createSubAgentCardProbe();
    const nestedMessage: ThreadMessage = {
      id: 'nested-message-1',
      role: 'assistant',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      content: [{ type: 'text', text: 'Nested agent response' }],
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {
          subAgent: {
            title: 'Research specialist',
            input: 'Find primary sources',
          },
        },
      },
    };

    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'sub-agent-1',
          toolName: 'create_sub_agent',
          args: {},
          messages: [nestedMessage],
        },
      ],
      { SubAgentCard },
    );

    expect(SubAgentCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentName: 'Research specialist',
        instruction: 'Find primary sources',
        stepCount: 1,
        status: 'success',
      }),
    );
    expect(screen.getByText('Nested agent response')).toBeInTheDocument();
  });

  it('hides completed nested reasoning while preserving the final answer', () => {
    const SubAgentCard = createSubAgentCardProbe();
    const nestedMessage: ThreadMessage = {
      id: 'nested-message-1',
      role: 'assistant',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      content: [
        { type: 'reasoning', text: 'Private working notes' },
        { type: 'text', text: 'Reviewed result' },
      ],
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };

    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: 'sub-agent-1',
          toolName: 'create_sub_agent',
          args: {},
          messages: [nestedMessage],
        },
      ],
      { SubAgentCard },
    );

    expect(screen.queryByText('Private working notes')).not.toBeInTheDocument();
    expect(screen.getByText('Reviewed result')).toBeInTheDocument();
  });

  it('routes Approve inside a sub-agent to the nested tool approval id', () => {
    respondToToolApproval.mockClear();
    const SubAgentCard = createSubAgentCardProbe();
    const nestedMessage: ThreadMessage = {
      id: 'nested-message-1',
      role: 'assistant',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      content: [
        {
          type: 'tool-call',
          toolCallId: 'nested-tool-1',
          toolName: 'delete_file',
          args: {},
          argsText: '{}',
          interrupt: { type: 'human', payload: {} },
          approval: {
            id: 'nested-approval-1',
            approved: undefined,
            options: [
              { id: 'allow-once', kind: 'allow-once' },
              { id: 'allow-chat', kind: 'allow-always' },
              { id: 'deny', kind: 'reject-once', confirm: {} },
            ],
          },
        },
      ],
      status: { type: 'requires-action', reason: 'tool-calls' },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {
          subAgent: {
            title: 'Research specialist',
            input: 'Clean up temp files',
          },
        },
      },
    };

    render(
      <SlotsProvider overrides={{ SubAgentCard }}>
        <RuntimeHarness
          messages={[
            {
              role: 'assistant',
              status: { type: 'requires-action', reason: 'tool-calls' },
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'sub-agent-1',
                  toolName: 'create_sub_agent',
                  args: {},
                  // Parent create_sub_agent has no approval — only the nested tool does.
                  messages: [nestedMessage],
                },
              ],
            },
          ]}
        >
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </RuntimeHarness>
      </SlotsProvider>,
    );

    expect(screen.getByRole('radio', { name: 'Approve for this chat' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'nested-approval-1', approved: true }),
    );
  });

  it('auto-expands and shows the approval bar while an approval is pending', () => {
    renderPendingApprovalMessage([
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'delete_file',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: { id: 'approval-1', approved: undefined },
      },
    ]);
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /in this chat/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deny' })).toBeInTheDocument();
  });

  it('keeps a pending approval visible — the disclosure locks open while approval waits', () => {
    renderPendingApprovalMessage([
      {
        type: 'tool-call',
        toolCallId: 'completed-tool',
        toolName: 'read_file',
        args: {},
        result: 'file contents',
      },
      {
        type: 'tool-call',
        toolCallId: 'pending-tool',
        toolName: 'write_file',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: { id: 'approval-1', approved: undefined },
      },
    ]);

    // No collapse toggle while an approval is waiting — the controls the user
    // must act on can never be hidden behind the trace.
    expect(
      screen.queryByRole('button', { name: /Expand agent details|Collapse agent details/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deny' })).toBeInTheDocument();
  });

  it('routes a root Approve through the runtime onRespondToToolApproval callback', () => {
    const onRespondToToolApproval = vi.fn();
    renderPendingApprovalMessage(
      [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'delete_file',
          args: {},
          interrupt: { type: 'human', payload: {} },
          approval: { id: 'approval-1', approved: undefined },
        },
      ],
      { onRespondToToolApproval },
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-1', approved: true }),
    );
  });

  it('preserves the chat scope option when Approve for this chat is clicked', () => {
    respondToToolApproval.mockClear();
    const onRespondToToolApproval = vi.fn();
    renderPendingApprovalMessage(
      [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'delete_file',
          args: {},
          interrupt: { type: 'human', payload: {} },
          approval: {
            id: 'approval-1',
            approved: undefined,
            options: [
              { id: 'allow-once', kind: 'allow-once' },
              { id: 'allow-chat', kind: 'allow-always' },
              { id: 'deny', kind: 'reject-once', confirm: {} },
            ],
          },
        },
      ],
      { onRespondToToolApproval },
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Approve for this chat' }));
    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-1', approved: true, optionId: 'allow-chat' }),
    );
    expect(onRespondToToolApproval).not.toHaveBeenCalled();
  });

  it('shows approval controls for sandbox execution', () => {
    renderPendingApprovalMessage([
      {
        type: 'tool-call',
        toolCallId: 'sandbox-approval',
        toolName: 'sandbox_exec',
        args: {},
        argsText: JSON.stringify({ command: 'pnpm test', intent: 'Run focused tests' }),
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: 'approval-sandbox',
          approved: undefined,
          options: [
            { id: 'allow-once', kind: 'allow-once' },
            { id: 'allow-chat', kind: 'allow-always' },
            { id: 'deny', kind: 'reject-once', confirm: {} },
          ],
        },
      },
    ]);

    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Approve for this chat' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deny' })).toBeInTheDocument();
  });

  it('includes the denial reason when Deny is submitted', () => {
    const onRespondToToolApproval = vi.fn();
    renderPendingApprovalMessage(
      [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'delete_file',
          args: {},
          interrupt: { type: 'human', payload: {} },
          approval: { id: 'approval-1', approved: undefined },
        },
      ],
      { onRespondToToolApproval },
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Deny' }));
    fireEvent.change(screen.getByPlaceholderText('Enter reason for denial'), {
      target: { value: 'Denied by user' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onRespondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'approval-1',
        approved: false,
        reason: 'Denied by user',
      }),
    );
  });

  it('renders declared approval options with their labels', () => {
    renderPendingApprovalMessage([
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'run_migration',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: 'approval-1',
          approved: undefined,
          options: [
            { id: 'opt-allow', kind: 'allow-once' },
            { id: 'opt-deny', kind: 'reject-once' },
          ],
        },
      },
    ]);
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deny' })).toBeInTheDocument();
  });

  it('forwards confirmation copy and grants to the denial option', () => {
    renderPendingApprovalMessage([
      {
        type: 'tool-call',
        toolCallId: '1',
        toolName: 'run_migration',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: 'approval-1',
          approved: undefined,
          options: [
            { id: 'opt-allow', kind: 'allow-once' },
            {
              id: 'opt-deny',
              kind: 'reject-once',
              grants: ['database:write'],
              confirm: {
                title: 'Confirm denial',
                description: 'The migration will not run.',
              },
            },
          ],
        },
      },
    ]);
    fireEvent.click(screen.getByRole('radio', { name: 'Deny' }));
    expect(screen.getByText('Confirm denial')).toBeInTheDocument();
    expect(screen.getByText('The migration will not run.')).toBeInTheDocument();
    expect(screen.getByText('database:write')).toBeInTheDocument();
  });

  it.each([
    ['list_tools', '{"mcp_server":"github-team"}', 'github-team'],
    ['call_tool', '{"mcp_server":"slack-workspace","tool_name":"send_message","input":{}}', 'slack-workspace'],
    ['get_tool_info', '{"mcp_server":"linear-integration","tool_name":"create_issue"}', 'linear-integration'],
  ])('passes mcpServerName for %s', (toolName, argsText, mcpServerName) => {
    const ToolCallCard = createToolCallCardProbe();
    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName,
          args: {},
          argsText,
        },
      ],
      { ToolCallCard },
    );

    expect(ToolCallCard.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ mcpServerName }));
  });

  it('does not pass mcpServerName for non-MCP tools', () => {
    const ToolCallCard = createToolCallCardProbe();
    renderToolCallMessage(
      [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'search_docs',
          args: {},
          argsText: '{"query":"example"}',
        },
      ],
      { ToolCallCard },
    );

    expect(ToolCallCard).toHaveBeenCalledOnce();
    const [call] = ToolCallCard.mock.calls;
    if (!call) throw new Error('Expected ToolCallCard to render');
    expect(call[0].mcpServerName).toBeUndefined();
  });

  describe('a chat that moved past the turn that asked', () => {
    function pendingCall(id: string): Exclude<ThreadMessageLike['content'], string>[number] {
      return {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'web_search',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: {
          id,
          approved: undefined,
          options: [
            { id: 'allow-once', kind: 'allow-once' as const },
            { id: 'deny', kind: 'reject-once' as const, confirm: {} },
          ],
        },
      };
    }

    function renderChat(messages: ThreadMessageLike[]) {
      return render(
        <RuntimeHarness messages={messages}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </RuntimeHarness>,
      );
    }

    it('shows an older pending card as expired, with no buttons', () => {
      renderChat([
        { role: 'assistant', content: [pendingCall('old')], status: { type: 'requires-action', reason: 'tool-calls' } },
        { role: 'user', content: 'next question' },
        { role: 'assistant', content: 'an answer' },
      ]);

      expect(screen.getByText('This request expired.')).toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Deny' })).not.toBeInTheDocument();
    });

    it('still lets the newest pending card be answered', () => {
      renderChat([
        { role: 'assistant', content: [pendingCall('old')], status: { type: 'requires-action', reason: 'tool-calls' } },
        { role: 'user', content: 'next question' },
        { role: 'assistant', content: [pendingCall('now')], status: { type: 'requires-action', reason: 'tool-calls' } },
      ]);

      expect(screen.getAllByText('This request expired.')).toHaveLength(1);
      expect(screen.getAllByRole('radio', { name: 'Approve' })).toHaveLength(1);
    });

    it('expires the older connector card read back from saved history, and keeps the newest one answerable', async () => {
      const outboundCard = (host: string): SentinelApprovalInfo['card'] => ({
        plain_what: 'Send a message through a connector.',
        plain_why: null,
        cannot_be_undone: null,
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: 'text: hello',
        destination_host: host,
        outbound_truncated: false,
        email: null,
      });
      const approval = (toolCallId: string, host: string): SentinelApprovalInfo => ({
        toolCallId,
        tier: 3,
        card: outboundCard(host),
        eventId: null,
        threadId: null,
      });
      const api: SentinelApi = {
        listAuditEntries: vi.fn(async () => []),
        getUserSettings: vi.fn(async () => ({
          offline_mode: false,
          tier2_auto_allow: [],
          search_without_asking: true,
        })),
        updateUserSettings: vi.fn(async () => ({
          offline_mode: false,
          tier2_auto_allow: [],
          search_without_asking: true,
        })),
        listSentinelSessionContext: vi.fn(async () => ({
          approvals: [approval('old', 'old.example.com'), approval('now', 'now.example.com')],
        })),
      };
      render(
        <RuntimeHarness
          threadId="local-1"
          remoteId="session-1"
          messages={[
            {
              role: 'assistant',
              content: [pendingCall('old')],
              status: { type: 'requires-action', reason: 'tool-calls' },
            },
            { role: 'user', content: 'next question' },
            {
              role: 'assistant',
              content: [pendingCall('now')],
              status: { type: 'requires-action', reason: 'tool-calls' },
            },
          ]}
        >
          <SentinelApiProvider api={api}>
            <SentinelStateProvider>
              <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
            </SentinelStateProvider>
          </SentinelApiProvider>
        </RuntimeHarness>,
      );

      expect(await screen.findByText('now.example.com')).toBeInTheDocument();
      expect(screen.queryByText('old.example.com')).not.toBeInTheDocument();
      expect(screen.getAllByText('Sends to')).toHaveLength(1);
      expect(screen.getAllByText('This request expired.')).toHaveLength(1);
    });
  });
});

describe('ToolCallContainer: held search request', () => {
  const rawKey = 'wsk-live-7Q2mZ9pL4vR8tN3x';
  const argsText = JSON.stringify({ query: `how do I rotate ${rawKey} safely` });

  function renderHeldSearch(call: Record<string, unknown>, status?: ThreadMessageLike['status']) {
    const card: SentinelApprovalInfo['card'] = {
      plain_what: searchHoldCardText({
        server: 'finder',
        query: 'how do I rotate ws••••••3x safely',
        why: "it contains one of this computer's keys",
      }),
      plain_why: null,
      cannot_be_undone: null,
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: 'query: how do I rotate ws••••••3x safely',
      destination_host: null,
      outbound_truncated: false,
      email: null,
    };
    const info: SentinelApprovalInfo = { toolCallId: 'search-1', tier: 3, card, eventId: null, threadId: null };
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      getUserSettings: vi.fn(async () => ({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true })),
      updateUserSettings: vi.fn(async () => ({
        offline_mode: false,
        tier2_auto_allow: [],
        search_without_asking: true,
      })),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [info] })),
    };
    const message: ThreadMessageLike = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'search-1', toolName: 'web_search', args: {}, argsText, ...call }],
      ...(status === undefined ? {} : { status }),
    };
    return render(
      <RuntimeHarness threadId="local-1" remoteId="session-1" messages={[message]}>
        <SentinelApiProvider api={api}>
          <SentinelStateProvider>
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </SentinelStateProvider>
        </SentinelApiProvider>
      </RuntimeHarness>,
    );
  }

  it('shows the masked arguments in the Request block of an answered hold, never the raw key', async () => {
    const { container } = renderHeldSearch({ result: 'ok' });
    await screen.findByText('web_search');
    fireEvent.click(screen.getByText('web_search'));
    const blocks = await screen.findAllByTestId('tfy-tool-call-content-block');
    expect(blocks[0]).toHaveAttribute('data-content', 'query: how do I rotate ws••••••3x safely');
    expect(container.innerHTML).not.toContain(rawKey);
  });

  it('shows the masked arguments while the hold waits for an answer', async () => {
    const { container } = renderHeldSearch(
      {
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: 'search-1',
          approved: undefined,
          options: [
            { id: 'allow-once', kind: 'allow-once' as const },
            { id: 'deny', kind: 'reject-once' as const, confirm: {} },
          ],
        },
      },
      { type: 'requires-action', reason: 'tool-calls' },
    );
    expect(await screen.findAllByTestId('tfy-tool-call-content-block')).toHaveLength(1);
    expect(container.innerHTML).not.toContain(rawKey);
  });
});
