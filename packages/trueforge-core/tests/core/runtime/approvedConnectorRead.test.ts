/**
 * A call the person said yes to must run when the chat is opened again with that yes saved but the call never made.
 * It is never closed as "did not run" while the next step is the one that runs it.
 */
import { EventType } from '../../../src/core/events/schema';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState } from '../../../src/core/mcp/executeToolCalls';
import type { ToolSource } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions';
import { approvalExpiredReason } from '../../../src/core/permissions/approvalExpiry';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadSnapshot } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger } from '../harnessMocks';

const OWNER = { tenant_id: 't1', created_by: 'u1' };
const ROOT_ID = 'thread_root';
const CHILD_ID = 'thread_child';

type CallSpec = { id: string; name: string; args: string };
type ToolAnnotations = { readOnlyHint?: boolean; openWorldHint?: boolean };

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

function makeSource(input: { name: string; tool: string; reply: string; annotations?: ToolAnnotations }): {
  source: ToolSource;
  callTool: jest.Mock<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>;
} {
  const callTool = jest.fn<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>(() =>
    Promise.resolve(toolResultResponse({ text: input.reply })),
  );
  const tools = [
    {
      name: input.tool,
      description: 'A tool for the test',
      inputSchema: { type: 'object' as const, properties: {} },
      ...(input.annotations === undefined ? {} : { annotations: input.annotations }),
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
  // The owner has always allowed reading a space, so that call never asks; everything else here does.
  await services.tool_grants.recordToolGrant({
    ...OWNER,
    mcp_server_name: 'Spaces',
    tool_name: 'get_space',
    mcp_server_host: null,
  });
  return services;
}

type Services = Awaited<ReturnType<typeof makeServices>>;

/** One request of the chat: a thread rebuilt from what the last request saved, as the server does. */
function build(input: {
  services: Services;
  script?: (() => ReturnType<typeof textReplyStream>)[];
  saved?: Pick<AgentThreadSnapshot, 'context' | 'tool_call_memo'>;
  /** Marks the Email connector as the host's own sidecar and makes every one of its tools ask. */
  hostMail?: boolean | undefined;
  /** The same for the Calendar connector. */
  hostCalendar?: boolean | undefined;
  /** Runs as a helper started by another thread, not as the chat's own thread. */
  subAgent?: boolean | undefined;
}) {
  const sentinel = createSentinelHostContext({ ...OWNER, conversation_id: 'c1', services: input.services });
  const sources = {
    space: makeSource({
      name: 'Spaces',
      tool: 'get_space',
      reply: 'space notes',
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),
    mail: makeSource({
      name: 'Email',
      tool: 'get_emails_content',
      reply: 'three emails',
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),
    calendar: makeSource({ name: 'Calendar', tool: 'list_events', reply: '[]' }),
    notes: makeSource({ name: 'Notes', tool: 'save_note', reply: 'saved' }),
    claim: makeSource({
      name: 'Misc',
      tool: 'do_thing',
      reply: 'done',
      annotations: { readOnlyHint: true },
    }),
  };
  const toolSets = Object.entries(sources).map(([key, { source }]) => {
    const hostOwned =
      (input.hostMail === true && key === 'mail') || (input.hostCalendar === true && key === 'calendar');
    return new ToolSet({
      source,
      selectors: {
        enableTools: ['@all'],
        disableTools: [],
        preloadTools: [],
        requireApprovalForTools: hostOwned ? ['@all'] : undefined,
      },
      preload: true,
      sentinel,
      searchProvider: undefined,
      firstParty: hostOwned,
    });
  });
  const llmCreate = jest.fn();
  for (const step of input.script ?? []) {
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
    threadId: input.subAgent === true ? CHILD_ID : ROOT_ID,
    title: 'approved read',
    parent: input.subAgent === true ? { thread_id: ROOT_ID, tool_call_id: 'launch' } : undefined,
    agentInfo: undefined,
    context: input.saved?.context ?? [{ role: 'user', content: 'Look at my email and my notes.' }],
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
  return {
    thread,
    calls: {
      space: sources.space.callTool,
      mail: sources.mail.callTool,
      notes: sources.notes.callTool,
      claim: sources.claim.callTool,
    },
  };
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const drained: T[] = [];
  for await (const event of events) {
    drained.push(event);
  }
  return drained;
}

/** What each call ended as, read from the saved chat, so a call closed before the step counts too. */
function dispositions(thread: AgentThread): [string, string][] {
  return thread.toSnapshot().context.flatMap(message => {
    if (!('role' in message) || message.role !== 'tool' || typeof message.content !== 'string') {
      return [];
    }
    const envelope: unknown = JSON.parse(message.content);
    const outcome =
      typeof envelope === 'object' && envelope !== null && 'outcome' in envelope ? envelope.outcome : null;
    const disposition =
      typeof outcome === 'object' && outcome !== null && 'disposition' in outcome ? outcome.disposition : null;
    return typeof disposition === 'string' ? [[message.tool_call_id, disposition] as [string, string]] : [];
  });
}

/** The chat asks about the calls the model made in one step. */
async function ask(input: {
  services: Services;
  calls: CallSpec[];
  hostMail?: boolean | undefined;
  subAgent?: boolean | undefined;
}) {
  const asking = build({
    services: input.services,
    script: [() => toolCallsStream(input.calls)],
    hostMail: input.hostMail,
    subAgent: input.subAgent,
  });
  const events = await drain(asking.thread.execute({ signal: new AbortController().signal }));
  return { events, saved: asking.thread.toSnapshot() };
}

/**
 * The chat asks, the person answers, and the answers are saved. Then the run stops before any call is made, so the
 * next request finds the answers and no results.
 */
async function askThenSaveAnswers(input: {
  services: Services;
  calls: CallSpec[];
  answers: { id: string; approval: { status: 'allow' } | { status: 'deny'; reason?: string } }[];
  hostMail?: boolean | undefined;
  subAgent?: boolean | undefined;
}) {
  const { saved: asked } = await ask(input);
  const saving = build({ services: input.services, saved: asked, hostMail: input.hostMail, subAgent: input.subAgent });
  await drain(
    saving.thread.send(
      input.answers.map(answer => ({
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: input.subAgent === true ? CHILD_ID : ROOT_ID,
        tool_call_id: answer.id,
        approval: answer.approval,
      })),
    ),
  );
  return { saved: saving.thread.toSnapshot() };
}

const SPACE_AND_MAIL: CallSpec[] = [
  { id: 'call-space', name: 'get_space', args: '{}' },
  { id: 'call-mail', name: 'get_emails_content', args: '{}' },
];
const READ_AND_WRITE: CallSpec[] = [
  { id: 'call-space', name: 'get_space', args: '{}' },
  { id: 'call-note', name: 'save_note', args: JSON.stringify({ text: 'Lunch at noon' }) },
];

describe('a call that asked first and was allowed, when the chat is opened again', () => {
  it('runs an allowed email read and the space read made in the same step', async () => {
    const services = await makeServices();
    const { saved } = await askThenSaveAnswers({
      services,
      calls: SPACE_AND_MAIL,
      answers: [{ id: 'call-mail', approval: { status: 'allow' } }],
    });

    const resumed = build({ services, saved });
    await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(dispositions(resumed.thread)).toEqual([
      ['call-space', 'executed_ok'],
      ['call-mail', 'executed_ok'],
    ]);
    expect(resumed.calls.mail).toHaveBeenCalledTimes(1);
  });

  it('runs an allowed change that never started, next to a read made in the same step', async () => {
    const services = await makeServices();
    const { saved } = await askThenSaveAnswers({
      services,
      calls: READ_AND_WRITE,
      answers: [{ id: 'call-note', approval: { status: 'allow' } }],
    });

    const resumed = build({ services, saved });
    await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(dispositions(resumed.thread)).toEqual([
      ['call-space', 'executed_ok'],
      ['call-note', 'executed_ok'],
    ]);
    expect(resumed.calls.notes).toHaveBeenCalledTimes(1);
  });

  it('does the same for a helper thread started by another thread', async () => {
    const services = await makeServices();
    const { saved } = await askThenSaveAnswers({
      services,
      calls: READ_AND_WRITE,
      answers: [{ id: 'call-note', approval: { status: 'allow' } }],
      subAgent: true,
    });

    const resumed = build({ services, saved, subAgent: true });
    await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(dispositions(resumed.thread)).toEqual([
      ['call-space', 'executed_ok'],
      ['call-note', 'executed_ok'],
    ]);
    expect(resumed.calls.notes).toHaveBeenCalledTimes(1);
  });

  it('does not run an allowed call when the connector alone says it only reads', async () => {
    const services = await makeServices();
    const { saved } = await askThenSaveAnswers({
      services,
      calls: [{ id: 'call-claim', name: 'do_thing', args: '{}' }],
      answers: [{ id: 'call-claim', approval: { status: 'allow' } }],
    });

    const resumed = build({ services, saved });
    await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(dispositions(resumed.thread)).toEqual([['call-claim', 'never_ran']]);
    expect(resumed.calls.claim).not.toHaveBeenCalled();
  });

  it('does not run a call whose card expired, and still runs the read made in the same step', async () => {
    const services = await makeServices();
    const { saved } = await askThenSaveAnswers({
      services,
      calls: READ_AND_WRITE,
      answers: [{ id: 'call-note', approval: { status: 'deny', reason: approvalExpiredReason() } }],
    });

    const resumed = build({ services, saved });
    await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(dispositions(resumed.thread)).toEqual([
      ['call-note', 'denied'],
      ['call-space', 'executed_ok'],
    ]);
    expect(resumed.calls.notes).not.toHaveBeenCalled();
  });

  it('keeps asking, and runs nothing, while a call is still undecided', async () => {
    const services = await makeServices();
    const { saved } = await ask({ services, calls: READ_AND_WRITE });

    const resumed = build({ services, saved });
    const events = await drain(resumed.thread.execute({ signal: new AbortController().signal }));

    expect(events.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(dispositions(resumed.thread)).toEqual([]);
    expect(resumed.calls.space).not.toHaveBeenCalled();
    expect(resumed.calls.notes).not.toHaveBeenCalled();
  });
});

describe('the card for a read that asks because of a setting', () => {
  it('says "reading your email", with no warning, for the host\'s own Email', async () => {
    const asking = build({
      services: await makeServices(),
      script: [() => toolCallsStream([{ id: 'call-mail', name: 'get_emails_content', args: '{}' }])],
      hostMail: true,
    });
    const events = await drain(asking.thread.execute({ signal: new AbortController().signal }));

    expect(events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [
        { id: 'call-mail', tier3_card: { plain_what: 'Allow reading your email?', cannot_be_undone: null } },
      ],
    });
  });

  it("is the generic card for a connector named Email that is not the host's own", async () => {
    const asking = build({
      services: await makeServices(),
      script: [() => toolCallsStream([{ id: 'call-mail', name: 'get_emails_content', args: '{}' }])],
    });
    const events = await drain(asking.thread.execute({ signal: new AbortController().signal }));

    expect(events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [
        { id: 'call-mail', tier3_card: { cannot_be_undone: 'It is not clear whether this can be undone.' } },
      ],
    });
  });

  it('says "looking at your calendar", with no warning, for the host\'s own Calendar', async () => {
    const asking = build({
      services: await makeServices(),
      script: [() => toolCallsStream([{ id: 'call-calendar', name: 'list_events', args: '{}' }])],
      hostCalendar: true,
    });
    const events = await drain(asking.thread.execute({ signal: new AbortController().signal }));

    expect(events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [
        { id: 'call-calendar', tier3_card: { plain_what: 'Allow looking at your calendar?', cannot_be_undone: null } },
      ],
    });
  });
});
