import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import {
  mintImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../../src/core/mcp/implementationPlanGrant';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { SANDBOX_MCP_SERVER_ID, SANDBOX_REPLACE_TEXT_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const plan = {
  repository_id: 'repository-a',
  repository_revision: 7,
  branch: 'codex/plan-grants',
  head_sha: 'abcdef012345',
  file_globs: ['packages/core/src/**/*.ts'],
  approach: 'Update the scoped runtime behavior.',
  verify_command_ids: ['core-test'],
};

const grant = mintImplementationPlanGrant({
  tenant_id: 'tenant-a',
  created_by: 'user-a',
  session_id: 'session-a',
  workspace_cwd: '/repo',
  checkout_id: `sha256:${'1'.repeat(64)}`,
  plan,
});

function makePlanToolSet(onDispatch?: () => void): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: SANDBOX_MCP_SERVER_ID,
    preload: true,
    tools: [
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        description: 'Replace text in a repository file.',
        inputSchema: OBJECT_INPUT_SCHEMA,
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: SANDBOX_MCP_SERVER_ID,
    mcp_server_name: SANDBOX_MCP_SERVER_ID,
    original_tool_name: `${SANDBOX_REPLACE_TEXT_TOOL_NAME}:edit`,
    is_approval_required: true,
    is_client_side: false,
    effect: 'edit',
    implementation_plan_scope: { kind: 'paths', paths: ['packages/core/src/runtime.ts'] },
    implementation_plan_binding: {
      repository_id: plan.repository_id,
      repository_revision: plan.repository_revision,
      workspace_cwd: grant.workspace_cwd,
      branch: plan.branch,
      head_sha: plan.head_sha,
      checkout_id: grant.checkout_id,
    },
  });
  jest.mocked(toolSet.callTool).mockImplementation(() => {
    onDispatch?.();
    return Promise.resolve(toolResultResponse({ text: 'updated' }));
  });
  return toolSet;
}

async function* editStream(
  callId: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: callId,
    type: 'function' as const,
    function: {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: JSON.stringify({
        intent: 'Update the runtime',
        cwd: '/repo',
        path: 'packages/core/src/runtime.ts',
        old_text: 'before',
        new_text: 'after',
      }),
    },
  };
  yield {
    id: `${callId}-chunk`,
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
}

async function* finalStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeThread(input: {
  modelClient: ILLM;
  toolSet: IToolSet;
  loadImplementationPlanGrants: () => Promise<ReadonlySet<string>>;
}): AgentThread {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: input.modelClient,
      instruction: 'test',
      toolSets: [input.toolSet],
    },
    context: [{ role: 'user', content: 'Update the runtime.' }],
    chatApprovalGrants: new Set(),
    loadImplementationPlanGrants: input.loadImplementationPlanGrants,
  });
}

describe('AgentThread implementation-plan revocation admission boundary', () => {
  it('prompts for the same edit after its plan grant is revoked between turns', async () => {
    let active = true;
    const serialized = serializeImplementationPlanGrant(grant);
    const toolSet = makePlanToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() => editStream('first-turn-edit'))
      .mockImplementationOnce(() => finalStream('First turn complete.'))
      .mockImplementationOnce(() => editStream('second-turn-edit'));
    const thread = makeThread({
      modelClient: { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) },
      toolSet,
      loadImplementationPlanGrants: () => Promise.resolve(active ? new Set([serialized]) : new Set()),
    });

    const firstEvents = [];
    for await (const event of thread.execute()) firstEvents.push(event);
    expect(firstEvents.map(event => event.type)).not.toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(toolSet.callTool).toHaveBeenCalledTimes(1);

    active = false;
    for await (const event of thread.send([{ type: EventType.USER_MESSAGE, content: 'Make the same edit again.' }])) {
      void event;
    }

    const secondEvents = [];
    for await (const event of thread.execute()) secondEvents.push(event);
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_APPROVAL_REQUIRED,
        tool_calls: [expect.objectContaining({ id: 'second-turn-edit' })],
      }),
    );
    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
  });

  it('prompts when a running turn loses its plan grant before a later tool batch', async () => {
    let active = true;
    const serialized = serializeImplementationPlanGrant(grant);
    const toolSet = makePlanToolSet(() => {
      active = false;
    });
    const create = jest
      .fn()
      .mockImplementationOnce(() => editStream('running-first-edit'))
      .mockImplementationOnce(() => editStream('running-second-edit'));
    const thread = makeThread({
      modelClient: { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) },
      toolSet,
      loadImplementationPlanGrants: () => Promise.resolve(active ? new Set([serialized]) : new Set()),
    });

    const events = [];
    for await (const event of thread.execute()) events.push(event);

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_APPROVAL_REQUIRED,
        tool_calls: [expect.objectContaining({ id: 'running-second-edit' })],
      }),
    );
  });
});
