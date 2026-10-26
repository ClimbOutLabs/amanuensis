/**
 * A read that asks first must run once the person says yes, even when the same step also made another
 * call. It is never closed as "did not run" while its answer is on its way to being carried out.
 */
import { EventType } from '../../../src/core/events/schema';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState } from '../../../src/core/mcp/executeToolCalls';
import type { ToolSource } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadExecutionEvent, AgentThreadSnapshot } from '../../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger } from '../harnessMocks';

const ROOT_ID = 'thread_root';
const OWNER = { tenant_id: 't1', created_by: 'u1' };
const MAIL_SERVER = 'Email';
const SPACES_SERVER = 'Spaces';

type CallSpec = { id: string; name: string; args: string };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallsStream(
  calls: CallSpec[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = calls.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.args },
  }));
  yield {
    id: 'chunk-tools',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

function makeSource(input: { name: string; tool: string; reply: string }): {
  source: ToolSource;
  callTool: jest.Mock<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>;
} {
  const callTool = jest.fn<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>(() =>
    Promise.resolve(toolResultResponse({ text: input.reply })),
  );
  const tools = [
    {
      name: input.tool,
      description: 'Reads and changes nothing',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      preload: true,
    },
  ];
  return {
    callTool,
    source: {
      name: input.name,
      id: input.name,
      listTools: () => Promise.resolve({ result: { tools }, wasInitialized: undefined }),
      callTool,
      toolCallInfo: params =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: input.name,
          mcp_server_name: input.name,
          original_tool_name: params.name,
        }),
    },
  };
}

/** The same services serve every request of the chat, as on the server: approval tokens live in them. */
async function makeServices() {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  // The owner has always allowed reading a space, so that call never asks; reading mail does.
  await services.tool_grants.recordToolGrant({
    ...OWNER,
    mcp_server_name: SPACES_SERVER,
    tool_name: 'get_space',
    mcp_server_host: null,
  });
  return services;
}

function build(input: {
  /** Marks the Email connector as the host's own sidecar and makes every one of its tools ask. */
  hostMail?: boolean;
  script: (() => ReturnType<typeof textReplyStream>)[];
  services: Awaited<ReturnType<typeof makeServices>>;
  /** What the chat saved when it paused: the thread's context and its tool-call memory. */
  saved?: Pick<AgentThreadSnapshot, 'context' | 'tool_call_memo'>;
}) {
  const { services } = input;
  const sentinel = createSentinelHostContext({ ...OWNER, conversation_id: 'c1', services });
  const spaces = makeSource({ name: SPACES_SERVER, tool: 'get_space', reply: 'space notes' });
  const mail = makeSource({ name: MAIL_SERVER, tool: 'get_emails_content', reply: 'three emails' });
  const toolSets = [spaces, mail].map(
    ({ source }) =>
      new ToolSet({
        source,
        selectors: {
          enableTools: ['@all'],
          disableTools: [],
          preloadTools: [],
          requireApprovalForTools: input.hostMail === true && source === mail.source ? ['@all'] : undefined,
        },
        preload: true,
        sentinel,
        searchProvider: undefined,
        firstParty: input.hostMail === true && source === mail.source,
      }),
  );
  const llmCreate = jest.fn();
  for (const step of input.script) {
    llmCreate.mockImplementationOnce(step);
  }
  llmCreate.mockImplementation(() => textReplyStream('All done.'));
  const thread = new AgentThread({
    definition: {
      modelClient: { create: llmCreate, createNonStream: jest.fn() },
      instruction: 'You are running in a test setup.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets,
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: ROOT_ID,
    title: 'approved read',
    parent: undefined,
    agentInfo: undefined,
    context: input.saved?.context,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: undefined,
    capabilityState: undefined,
    toolCallMemo: input.saved?.tool_call_memo,
    turnToolCallLedger: createToolCallMemoState(input.saved?.tool_call_memo).turn,
    taskState: undefined,
    isRequestContinuation: input.saved !== undefined,
    sentinel,
    stopAfterToolResponse: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  return { thread, orchestrator, spacesCall: spaces.callTool, mailCall: mail.callTool };
}

describe('a read that asked first and was allowed', () => {
  it('runs after the yes when the same step also read a space, and is not closed as never run', async () => {
    const script = [
      () =>
        toolCallsStream([
          { id: 'call-space', name: 'get_space', args: '{}' },
          { id: 'call-mail', name: 'get_emails_content', args: '{}' },
        ]),
    ];
    const services = await makeServices();
    const first = build({ script, services });
    const asked = await runTurn({
      orchestrator: first.orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is in my email?' }],
    });
    expect(asked.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [{ id: 'call-mail' }],
    });

    // The next request builds a fresh thread from what was saved, as the server does.
    const resumed = build({ script: [], services, saved: first.thread.toSnapshot() });
    const answered = await runTurn({
      orchestrator: resumed.orchestrator,
      sendBatch: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: ROOT_ID,
          tool_call_id: 'call-mail',
          approval: { status: 'allow' },
        },
      ],
    });

    expect(resumed.mailCall).toHaveBeenCalledTimes(1);
    const results = answered.events.flatMap(event => (event.type === EventType.TOOL_RESPONSE_V2 ? [event] : []));
    expect(results.find(result => result.tool_call_id === 'call-mail')?.disposition).toBe('executed_ok');
    expect(JSON.stringify(results)).not.toContain('tool_call_never_ran');
  });

  it('runs when the chat resumes after the yes was saved but the run was cut off', async () => {
    const script = [
      () =>
        toolCallsStream([
          { id: 'call-space', name: 'get_space', args: '{}' },
          { id: 'call-mail', name: 'get_emails_content', args: '{}' },
        ]),
    ];
    const services = await makeServices();
    const first = build({ script, services });
    await runTurn({
      orchestrator: first.orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is in my email?' }],
    });

    // The yes is saved with the chat, then the run stops before any call is made.
    const answering = build({ script: [], services, saved: first.thread.toSnapshot() });
    for await (const saved of answering.orchestrator.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: ROOT_ID,
        tool_call_id: 'call-mail',
        approval: { status: 'allow' },
      },
    ])) {
      void saved;
    }
    expect(answering.mailCall).not.toHaveBeenCalled();

    const resumed = build({ script: [], services, saved: answering.thread.toSnapshot() });
    const events: AgentThreadExecutionEvent[] = [];
    for await (const event of resumed.orchestrator.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    const results = events.flatMap(event => (event.type === EventType.TOOL_RESPONSE_V2 ? [event] : []));
    expect(results.map(result => [result.tool_call_id, result.disposition])).toEqual([
      ['call-space', 'executed_ok'],
      ['call-mail', 'executed_ok'],
    ]);
    expect(resumed.mailCall).toHaveBeenCalledTimes(1);
  });

  it("shows the plain reading line, and no warning, for the host's own Email when a setting makes it ask", async () => {
    const script = [() => toolCallsStream([{ id: 'call-mail', name: 'get_emails_content', args: '{}' }])];
    const services = await makeServices();
    const asked = await runTurn({
      orchestrator: build({ script, services, hostMail: true }).orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is in my email?' }],
    });
    expect(asked.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [
        { id: 'call-mail', tier3_card: { plain_what: 'Allow reading your email?', cannot_be_undone: null } },
      ],
    });
  });

  it("shows the generic line for a connector named Email that is not the host's own", async () => {
    const script = [() => toolCallsStream([{ id: 'call-mail', name: 'get_emails_content', args: '{}' }])];
    const services = await makeServices();
    const asked = await runTurn({
      orchestrator: build({ script, services }).orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is in my email?' }],
    });
    expect(asked.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [
        { id: 'call-mail', tier3_card: { cannot_be_undone: 'It is not clear whether this can be undone.' } },
      ],
    });
  });
});
