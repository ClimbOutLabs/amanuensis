import type { ChatCompletionTool } from 'openai/resources/chat';
import { EventType, newEventId, type AgentApprovalDecisionMessage } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  InternalEnrichedAssistantMessage,
  InternalEnrichedToolCall,
  RawAssistantMessage,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  approvalDecisionBinding,
  remapToolCallIdSet,
  scanApprovalDecisions,
  withHostUniqueToolCallIds,
} from '../../../src/core/runtime/contextUtils';
import { guardModelReply, TOOL_CALL_SIZE_CUT_MESSAGE } from '../../../src/core/runtime/modelReplyGuard';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function toolCall(input: { id: string; args: string; token?: string | null }): InternalEnrichedToolCall {
  return {
    id: input.id,
    type: 'function',
    function: { name: 'test_tool', arguments: input.args },
    tool_info: {
      type: 'mcp',
      mcp_server_id: 's',
      mcp_server_name: 's',
      original_tool_name: 'test_tool',
      is_approval_required: true,
      is_client_side: false,
      approval_token_id: input.token ?? null,
    },
  };
}

function assistant(...calls: InternalEnrichedToolCall[]): InternalEnrichedAssistantMessage {
  return { role: 'assistant', content: '', tool_calls: calls };
}

function allow(call: InternalEnrichedToolCall): AgentApprovalDecisionMessage {
  return {
    type: EventType.USER_TOOL_APPROVAL,
    tool_call_id: call.id,
    approval: { status: 'allow' },
    ...approvalDecisionBinding(call),
  };
}

describe('scanApprovalDecisions', () => {
  it('honours a decision recorded after the call it was issued for', () => {
    const call = toolCall({ id: 'a', args: '{"x":1}', token: 'tok-1' });
    const context: ContextMessage[] = [assistant(call), allow(call)];
    expect(scanApprovalDecisions(context).get('a')).toEqual({ status: 'allow' });
  });

  it('does not carry an approval over to a later call that reuses the id', () => {
    const first = toolCall({ id: 'a', args: '{"x":1}', token: 'tok-1' });
    const again = toolCall({ id: 'a', args: '{"x":1}', token: 'tok-2' });
    const context: ContextMessage[] = [
      assistant(first),
      allow(first),
      { role: 'tool', tool_call_id: 'a', content: 'done' },
      assistant(again),
    ];
    expect(scanApprovalDecisions(context).has('a')).toBe(false);
  });

  it('does not carry an approval over to a later call with other arguments and the same id', () => {
    const first = toolCall({ id: 'a', args: '{"command":"ls"}' });
    const changed = toolCall({ id: 'a', args: '{"command":"rm -rf /"}' });
    const context: ContextMessage[] = [assistant(first), allow(first), assistant(changed)];
    expect(scanApprovalDecisions(context).has('a')).toBe(false);
  });

  it('ignores a decision bound to other arguments or another approval token', () => {
    const call = toolCall({ id: 'a', args: '{"x":1}', token: 'tok-1' });
    const other = toolCall({ id: 'a', args: '{"x":2}', token: 'tok-1' });
    const otherToken = toolCall({ id: 'a', args: '{"x":1}', token: 'tok-9' });
    expect(scanApprovalDecisions([assistant(call), allow(other)]).has('a')).toBe(false);
    expect(scanApprovalDecisions([assistant(call), allow(otherToken)]).has('a')).toBe(false);
  });

  it('ignores a decision saved without a binding and a decision recorded before its call', () => {
    const call = toolCall({ id: 'a', args: '{}' });
    const unbound: AgentApprovalDecisionMessage = {
      type: EventType.USER_TOOL_APPROVAL,
      tool_call_id: 'a',
      approval: { status: 'allow' },
      approval_token_id: null,
      arguments_hash: null,
    };
    expect(scanApprovalDecisions([assistant(call), unbound]).has('a')).toBe(false);
    expect(scanApprovalDecisions([allow(call), assistant(call)]).has('a')).toBe(false);
  });
});

describe('withHostUniqueToolCallIds', () => {
  it('keeps fresh ids and replaces ids the context used or the batch repeats', () => {
    const used = toolCall({ id: 'reused', args: '{}' });
    const context: ContextMessage[] = [assistant(used), { role: 'tool', tool_call_id: 'reused', content: 'ok' }];
    const calls = [{ id: 'fresh' }, { id: 'reused' }, { id: 'fresh' }, { id: '' }];
    const unique = withHostUniqueToolCallIds({ calls, context }).map(call => call.id);
    expect(unique[0]).toBe('fresh');
    expect(new Set(unique).size).toBe(4);
    expect(unique.slice(1).every(id => id !== 'reused' && id !== '')).toBe(true);
    expect(unique[2]).not.toBe('fresh');
  });

  it('avoids an id that only a decision used', () => {
    const call = toolCall({ id: 'gone', args: '{}' });
    const [only] = withHostUniqueToolCallIds({ calls: [{ id: 'gone' }], context: [allow(call)] });
    expect(only?.id).not.toBe('gone');
  });
});

describe('remapToolCallIdSet', () => {
  it('moves the ids that were remapped, keeps the rest, and drops ids no call carries', () => {
    const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const after = [{ id: 'a' }, { id: 'call_new1' }, { id: 'call_new2' }];
    expect([...remapToolCallIdSet({ before, after, ids: new Set(['b', 'c', 'not-a-call']) })].sort()).toEqual([
      'call_new1',
      'call_new2',
    ]);
    expect([...remapToolCallIdSet({ before, after, ids: new Set(['a']) })]).toEqual(['a']);
    expect(remapToolCallIdSet({ before, after, ids: new Set() }).size).toBe(0);
  });
});

describe('a size-cut call whose id the host remaps', () => {
  const TOOLS: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'update_space',
        parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      },
    },
  ];

  function guardWith(unique: RawToolCall[], sizeCutCalls: ReadonlySet<string>) {
    const message: RawAssistantMessage = { role: 'assistant', content: null, tool_calls: unique };
    return guardModelReply({
      message,
      tools: TOOLS,
      knownEventIds: new Set(),
      readOnlyTools: new Set(),
      sizeCutCalls,
      callCountCut: false,
      sandboxToolNames: { runCode: undefined, exec: undefined },
    });
  }

  it('still gets the size-cut message from the reply guard', () => {
    // The provider reused an id an earlier turn already used, so the host remaps it.
    const earlier = toolCall({ id: 'cut-1', args: '{}' });
    const context: ContextMessage[] = [assistant(earlier), { role: 'tool', tool_call_id: 'cut-1', content: 'ok' }];
    const providerCalls: RawToolCall[] = [
      { id: 'cut-1', type: 'function', function: { name: 'update_space', arguments: '{"body":"partial' } },
      { id: 'fresh', type: 'function', function: { name: 'update_space', arguments: '{"body":"whole"}' } },
    ];
    const unique = withHostUniqueToolCallIds({ calls: providerCalls, context });
    const remappedId = unique[0]?.id;
    expect(remappedId).toBeDefined();
    expect(remappedId).not.toBe('cut-1');

    // Carried across the remap the way AgentThread carries it, the flag lands on the call.
    const carried = remapToolCallIdSet({ before: providerCalls, after: unique, ids: new Set(['cut-1']) });
    const outcome = guardWith(unique, carried);
    expect(remappedId === undefined ? undefined : outcome.invalidCalls.get(remappedId)).toBe(
      TOOL_CALL_SIZE_CUT_MESSAGE,
    );
    expect(outcome.invalidCalls.has('fresh')).toBe(false);

    // The bug this fixes: with the provider ids untranslated, the guard misses the flag and
    // the call gets only the generic incomplete-arguments message.
    const missed = guardWith(unique, new Set(['cut-1']));
    expect(remappedId === undefined ? undefined : missed.invalidCalls.get(remappedId)).not.toBe(
      TOOL_CALL_SIZE_CUT_MESSAGE,
    );
  });
});

function editChunks(input: {
  id: string;
  command: string;
}): () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return async function* () {
    const call = {
      id: input.id,
      type: 'function' as const,
      function: {
        name: 'exec',
        arguments: JSON.stringify({ intent: 'Edit', purpose: 'edit', command: input.command, cwd: '/tmp/repo' }),
      },
    };
    yield {
      id: newEventId(),
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: [call] },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  };
}

async function* doneChunks(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: newEventId(),
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
  };
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

function makeThread(
  streams: (() => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>)[],
) {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: jest.fn(),
    getImageBuildStatus: jest.fn(),
    createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-1' })),
    exec: jest.fn(() => Promise.resolve({ success: true as const, response: { exitCode: 0, result: '' } })),
    acknowledgeWorkspaceTermination: jest.fn(() => Promise.resolve()),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/tmp/tool-results',
    getGitCredentialsPath: () => '/tmp/.git-credentials',
    getFileUploadsDir: () => '/tmp/uploads',
    getSkillsDir: () => '/opt/tfy/skills',
    getSkillDownloaderPath: () => '/opt/tfy/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn(() => Promise.resolve()),
    createCodeModeTransport: jest.fn(),
  };
  const sandbox = new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
  const create = jest.fn();
  for (const stream of streams) {
    create.mockImplementationOnce(stream);
  }
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
    sandbox,
    context: [{ role: 'user', content: 'edit the repository' }],
  });
  return { thread };
}

interface Drained {
  types: string[];
  approvalIds: string[];
}

async function drain(events: AsyncIterable<{ type: string }>): Promise<Drained> {
  const drained: Drained = { types: [], approvalIds: [] };
  for await (const event of events) {
    drained.types.push(String(event.type));
    if ('tool_calls' in event && Array.isArray(event.tool_calls) && event.type === EventType.TOOL_APPROVAL_REQUIRED) {
      for (const call of event.tool_calls) {
        if (typeof call === 'object' && call !== null && 'id' in call && typeof call.id === 'string') {
          drained.approvalIds.push(call.id);
        }
      }
    }
  }
  return drained;
}

describe('approved tool call ids on a live thread', () => {
  async function approveFirstCall(input: { thread: AgentThread; id: string }): Promise<string[]> {
    const first = await drain(input.thread.execute({ signal: new AbortController().signal }));
    expect(first.types).toContain(EventType.TOOL_APPROVAL_REQUIRED);
    await drain(
      input.thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: input.id,
          approval: { status: 'allow' },
        },
      ]),
    );
    return first.approvalIds;
  }

  it.each([
    ['the same call', 'cp source target'],
    ['a call with changed arguments', 'cp source other-target'],
  ])('a later call reusing an approved id asks again: %s', async (_name, secondCommand) => {
    const { thread } = makeThread([
      editChunks({ id: 'reused', command: 'cp source target' }),
      editChunks({ id: 'reused', command: secondCommand }),
      doneChunks,
    ]);
    const firstIds = await approveFirstCall({ thread, id: 'reused' });

    const continuation = await drain(thread.execute({ signal: new AbortController().signal }));
    expect(continuation.types.filter(type => type === EventType.TOOL_APPROVAL_REQUIRED)).toHaveLength(1);
    // The model's reused id was replaced, so the old decision cannot answer the new request.
    expect(firstIds).toEqual(['reused']);
    expect(continuation.approvalIds).toHaveLength(1);
    expect(continuation.approvalIds).not.toContain('reused');
  });
});
