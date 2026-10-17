import { EventType, type AgentApprovalDecisionMessage, type ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall } from '../../../src/core/llm/LLMTypes';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { approvalDecisionBinding } from '../../../src/core/runtime/contextUtils';
import { getClosableOpenToolCalls } from '../../../src/core/runtime/OpenToolCallCloser';
import '../harnessMocks';

const NOT_EXECUTED = JSON.stringify({ error: 'Tool call was not executed. Please retry this tool call.' });
const UNKNOWN_OUTCOME = JSON.stringify({
  error:
    'Tool call outcome unknown: it may have run without its result being recorded. Do not repeat it blindly. Establish whether it already took effect, then continue.',
});

function makeToolCall(
  id: string,
  toolInfo: Partial<InternalEnrichedToolCall['tool_info']> = {},
): InternalEnrichedToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'test_tool', arguments: '{}' },
    tool_info: {
      type: 'mcp',
      mcp_server_id: 'test-server',
      mcp_server_name: 'test-server',
      original_tool_name: 'test_tool',
      is_approval_required: false,
      is_client_side: false,
      ...toolInfo,
    },
  };
}

/** A decision as the host records it: bound to the call makeToolCall builds for this id. */
function decisionFor(id: string, approval: ApprovalDecision): AgentApprovalDecisionMessage {
  return {
    type: EventType.USER_TOOL_APPROVAL,
    tool_call_id: id,
    approval,
    ...approvalDecisionBinding(makeToolCall(id)),
  };
}

function assistantWithToolCalls(toolCalls: InternalEnrichedToolCall[]): ContextMessage[] {
  const assistant: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls,
  };
  return [assistant];
}

describe('getClosableOpenToolCalls', () => {
  it('closes ordinary dangling tool calls on the last assistant message', () => {
    const context = assistantWithToolCalls([makeToolCall('tc-1'), makeToolCall('tc-2')]);
    expect(getClosableOpenToolCalls(context)).toEqual(
      new Map([
        ['tc-1', UNKNOWN_OUTCOME],
        ['tc-2', UNKNOWN_OUTCOME],
      ]),
    );
  });

  it('excludes tool calls that already have a matching tool response', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-1'), makeToolCall('tc-2')]),
      { role: 'tool', tool_call_id: 'tc-1', content: 'done' },
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-2', UNKNOWN_OUTCOME]]));
  });

  it('closes nothing while an approval-required call is still undecided', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-approval', { is_approval_required: true }),
    ]);
    expect(getClosableOpenToolCalls(context)).toEqual(new Map());
  });

  it('does not tell the model an allowed side-effecting call went unexecuted', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true, effect: 'edit' })]),
      decisionFor('tc-approval', { status: 'allow' }),
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-approval', UNKNOWN_OUTCOME]]));
  });

  it('allows retry only when the durable checkpoint proves a side effect never reached execution', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-edit', { effect: 'edit' })]),
      { type: 'internal.tool.execution_tracking', tool_call_ids: ['tc-edit'] },
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-edit', NOT_EXECUTED]]));
  });

  it('reports a started side effect with no terminal response as unknown and does not invite replay', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-edit', { effect: 'edit' })]),
      { type: 'internal.tool.execution_tracking', tool_call_ids: ['tc-edit'] },
      {
        type: EventType.TOOL_EXECUTION_STARTED,
        id: 'event-1',
        thread_id: 'main',
        tool_call_id: 'tc-edit',
        tool_name: 'test_tool',
        created_at: '2026-08-26T00:00:00.000Z',
      },
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-edit', UNKNOWN_OUTCOME]]));
  });

  it('invites a plain retry only when repeating the call is harmless', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-inspect', { effect: 'inspect' }),
      makeToolCall('tc-read-only', { read_only_hint: true }),
    ]);
    expect(getClosableOpenToolCalls(context)).toEqual(
      new Map([
        ['tc-inspect', NOT_EXECUTED],
        ['tc-read-only', NOT_EXECUTED],
      ]),
    );
  });

  it('treats a call with no effect metadata as side-effecting', () => {
    const context = assistantWithToolCalls([makeToolCall('tc-unknown')]);
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-unknown', UNKNOWN_OUTCOME]]));
  });

  it('closes a denied approval call with the denial the user gave', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'deny', reason: 'not this repo' }),
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(
      new Map([['tc-approval', JSON.stringify({ error: 'User denied tool call: not this repo' })]]),
    );
  });

  it('closes a denied approval call with no reason using the shared fallback wording', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'deny' }),
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(
      new Map([['tc-approval', JSON.stringify({ error: 'User denied tool call: no reason provided' })]]),
    );
  });

  it('keeps a decided call closed out once its tool response exists', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'allow' }),
      { role: 'tool', tool_call_id: 'tc-approval', content: 'executed' },
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map());
  });

  it('closes nothing when one approval call is decided and another is not', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([
        makeToolCall('tc-decided', { is_approval_required: true }),
        makeToolCall('tc-pending', { is_approval_required: true }),
      ]),
      decisionFor('tc-decided', { status: 'allow' }),
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map());
  });

  it('returns empty when any open call is client-side', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-client', { is_client_side: true }),
    ]);
    expect(getClosableOpenToolCalls(context)).toEqual(new Map());
  });

  it('excludes thread-creation tool calls (is_thread_creation)', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-regular'),
      makeToolCall('tc-sub-agent', { is_thread_creation: true }),
    ]);
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-regular', UNKNOWN_OUTCOME]]));
  });

  it('treats legacy sub-agent calls without is_thread_creation as ordinary closable calls', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-legacy-sub-agent', {
        mcp_server_id: 'legacy-sub-agents',
        mcp_server_name: 'legacy-sub-agents',
        original_tool_name: 'create_sub_agent',
      }),
    ]);
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['tc-legacy-sub-agent', UNKNOWN_OUTCOME]]));
  });

  it('only inspects tool calls on the last assistant message', () => {
    const context: ContextMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [makeToolCall('old-tc')],
      },
      { role: 'tool', tool_call_id: 'old-tc', content: 'resolved' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [makeToolCall('new-tc')],
      },
    ];
    expect(getClosableOpenToolCalls(context)).toEqual(new Map([['new-tc', UNKNOWN_OUTCOME]]));
  });

  it('returns empty when there is no assistant message with tool calls', () => {
    expect(getClosableOpenToolCalls([{ role: 'user', content: 'hello' }])).toEqual(new Map());
  });
});
