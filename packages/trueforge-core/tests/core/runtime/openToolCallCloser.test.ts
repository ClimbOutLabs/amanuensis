import { EventType, type AgentApprovalDecisionMessage, type ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall } from '../../../src/core/llm/LLMTypes';
import { approvalGrantKey } from '../../../src/core/mcp/approvalGrant';
import { deniedToolCallText } from '../../../src/core/mcp/ToolSet';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { approvalDecisionBinding } from '../../../src/core/runtime/contextUtils';
import {
  getClosableOpenToolCallOutcomes,
  getClosableOpenToolCalls,
} from '../../../src/core/runtime/OpenToolCallCloser';
import '../harnessMocks';

const NOT_EXECUTED = JSON.stringify({
  error:
    'Tool call was not executed. Only make this call again if the person asks for it again, or it is still needed for what they just asked.',
});
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

const NO_DENIALS: ReadonlySet<string> = new Set();

describe('getClosableOpenToolCalls', () => {
  it('closes ordinary dangling tool calls on the last assistant message', () => {
    const context = assistantWithToolCalls([makeToolCall('tc-1'), makeToolCall('tc-2')]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(
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
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-2', UNKNOWN_OUTCOME]]));
  });

  it('closes nothing while an approval-required call is still undecided', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-approval', { is_approval_required: true }),
    ]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map());
  });

  it('does not tell the model an allowed side-effecting call went unexecuted', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true, effect: 'edit' })]),
      decisionFor('tc-approval', { status: 'allow' }),
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-approval', UNKNOWN_OUTCOME]]));
  });

  it('allows retry only when the durable checkpoint proves a side effect never reached execution', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-edit', { effect: 'edit' })]),
      { type: 'internal.tool.execution_tracking', tool_call_ids: ['tc-edit'] },
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-edit', NOT_EXECUTED]]));
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
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-edit', UNKNOWN_OUTCOME]]));
  });

  it('invites a plain retry only when repeating the call is harmless', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-inspect', { effect: 'inspect' }),
      makeToolCall('tc-read-only', { read_only_hint: true }),
    ]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(
      new Map([
        ['tc-inspect', NOT_EXECUTED],
        ['tc-read-only', NOT_EXECUTED],
      ]),
    );
  });

  it('treats a call with no effect metadata as side-effecting', () => {
    const context = assistantWithToolCalls([makeToolCall('tc-unknown')]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-unknown', UNKNOWN_OUTCOME]]));
  });

  it('closes a denied approval call with the denial the user gave', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'deny', reason: 'not this repo' }),
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(
      new Map([['tc-approval', deniedToolCallText('not this repo')]]),
    );
  });

  it('closes a denied approval call with no reason using the shared fallback wording', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'deny' }),
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(
      new Map([['tc-approval', deniedToolCallText(undefined)]]),
    );
  });

  it('closes an unanswered call that repeats a no from this turn, and keeps a real wait open', () => {
    const repeat = makeToolCall('tc-repeat', { is_approval_required: true });
    const context = assistantWithToolCalls([repeat]);
    expect(getClosableOpenToolCalls(context, new Set([approvalGrantKey(repeat.tool_info)]))).toEqual(
      new Map([['tc-repeat', deniedToolCallText(undefined)]]),
    );
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map());
  });

  it('keeps a decided call closed out once its tool response exists', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([makeToolCall('tc-approval', { is_approval_required: true })]),
      decisionFor('tc-approval', { status: 'allow' }),
      { role: 'tool', tool_call_id: 'tc-approval', content: 'executed' },
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map());
  });

  it('closes nothing when one approval call is decided and another is not', () => {
    const context: ContextMessage[] = [
      ...assistantWithToolCalls([
        makeToolCall('tc-decided', { is_approval_required: true }),
        makeToolCall('tc-pending', { is_approval_required: true }),
      ]),
      decisionFor('tc-decided', { status: 'allow' }),
    ];
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map());
  });

  it('returns empty when any open call is client-side', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-ordinary'),
      makeToolCall('tc-client', { is_client_side: true }),
    ]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map());
  });

  it('excludes thread-creation tool calls (is_thread_creation)', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-regular'),
      makeToolCall('tc-sub-agent', { is_thread_creation: true }),
    ]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-regular', UNKNOWN_OUTCOME]]));
  });

  it('treats legacy sub-agent calls without is_thread_creation as ordinary closable calls', () => {
    const context = assistantWithToolCalls([
      makeToolCall('tc-legacy-sub-agent', {
        mcp_server_id: 'legacy-sub-agents',
        mcp_server_name: 'legacy-sub-agents',
        original_tool_name: 'create_sub_agent',
      }),
    ]);
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['tc-legacy-sub-agent', UNKNOWN_OUTCOME]]));
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
    expect(getClosableOpenToolCalls(context, NO_DENIALS)).toEqual(new Map([['new-tc', UNKNOWN_OUTCOME]]));
  });

  it('returns empty when there is no assistant message with tool calls', () => {
    expect(getClosableOpenToolCalls([{ role: 'user', content: 'hello' }], NO_DENIALS)).toEqual(new Map());
  });

  describe('when the turn goes straight to its tool step', () => {
    const RESUMING = { resuming: true };

    it('leaves reads the host vouched for, allowed or not, for the tool step to run', () => {
      const context: ContextMessage[] = [
        ...assistantWithToolCalls([
          makeToolCall('tc-space', { type: 'truefoundry-system', effect: 'inspect' }),
          makeToolCall('tc-calendar', { tier_reason: 'caldav_private_read' }),
          makeToolCall('tc-mail', { is_approval_required: true, tier_reason: 'mail_read' }),
        ]),
        decisionFor('tc-mail', { status: 'allow' }),
      ];
      expect(getClosableOpenToolCallOutcomes(context, NO_DENIALS, RESUMING)).toEqual(new Map());
    });

    it('closes a connector read whose only mark is its own claim or annotations, allowed or not', () => {
      const context: ContextMessage[] = [
        ...assistantWithToolCalls([
          makeToolCall('tc-claim', { read_only_hint: true }),
          // A connector's annotations alone also stamp this effect, so it is not the host's word.
          makeToolCall('tc-annotated', { effect: 'inspect', read_only_hint: true, open_world_hint: false }),
          makeToolCall('tc-claim-allowed', { is_approval_required: true, effect: 'inspect' }),
        ]),
        decisionFor('tc-claim-allowed', { status: 'allow' }),
      ];
      expect([...getClosableOpenToolCallOutcomes(context, NO_DENIALS, RESUMING).keys()]).toEqual([
        'tc-claim',
        'tc-annotated',
        'tc-claim-allowed',
      ]);
    });

    it('leaves an allowed change that never reached dispatch, and closes one that did', () => {
      const change = makeToolCall('tc-change', { is_approval_required: true, effect: 'edit' });
      const never: ContextMessage[] = [
        ...assistantWithToolCalls([change]),
        decisionFor('tc-change', { status: 'allow' }),
      ];
      expect(getClosableOpenToolCallOutcomes(never, NO_DENIALS, RESUMING)).toEqual(new Map());

      const tracked: ContextMessage[] = [
        ...never,
        { type: 'internal.tool.execution_tracking', tool_call_ids: ['tc-change'] },
      ];
      expect(getClosableOpenToolCallOutcomes(tracked, NO_DENIALS, RESUMING).get('tc-change')?.disposition).toBe(
        'never_ran',
      );

      const started: ContextMessage[] = [
        ...tracked,
        {
          type: EventType.TOOL_EXECUTION_STARTED,
          id: 'event-1',
          thread_id: 'main',
          tool_call_id: 'tc-change',
          tool_name: 'test_tool',
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ];
      expect(getClosableOpenToolCallOutcomes(started, NO_DENIALS, RESUMING).get('tc-change')?.disposition).toBe(
        'outcome_unknown',
      );
    });

    it('still closes a denied call, an unmarked change nobody allowed, and a call that already has its result', () => {
      const context: ContextMessage[] = [
        ...assistantWithToolCalls([
          makeToolCall('tc-denied', { is_approval_required: true, read_only_hint: true }),
          makeToolCall('tc-auto-change', { effect: 'edit' }),
          makeToolCall('tc-done', { effect: 'inspect' }),
        ]),
        decisionFor('tc-denied', { status: 'deny' }),
        { role: 'tool', tool_call_id: 'tc-done', content: 'done' },
      ];
      expect([...getClosableOpenToolCallOutcomes(context, NO_DENIALS, RESUMING).keys()]).toEqual([
        'tc-denied',
        'tc-auto-change',
      ]);
    });

    it('closes nothing while any call is still undecided', () => {
      const context = assistantWithToolCalls([
        makeToolCall('tc-space', { effect: 'inspect' }),
        makeToolCall('tc-claim', { read_only_hint: true }),
        makeToolCall('tc-pending', { is_approval_required: true }),
      ]);
      expect(getClosableOpenToolCallOutcomes(context, NO_DENIALS, RESUMING)).toEqual(new Map());
    });

    it('closes the same calls as before when a new message from the person is what comes next', () => {
      const context: ContextMessage[] = [
        ...assistantWithToolCalls([
          makeToolCall('tc-space', { type: 'truefoundry-system', effect: 'inspect' }),
          makeToolCall('tc-mail', { is_approval_required: true, tier_reason: 'mail_read' }),
        ]),
        decisionFor('tc-mail', { status: 'allow' }),
      ];
      expect([...getClosableOpenToolCallOutcomes(context, NO_DENIALS).keys()]).toEqual(['tc-space', 'tc-mail']);
    });
  });
});
