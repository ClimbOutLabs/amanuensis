/**
 * An unattended run holds every call that would ask, finishes everything else, and the owner's later
 * answer runs exactly the stored call once, with no model call.
 */
import { InvalidAgentSendInputError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadConstructorInput } from '../../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { TOO_MANY_TOOL_CALLS_MESSAGE } from '../../../src/core/runtime/modelReplyGuard';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger } from '../harnessMocks';

const ROOT_ID = 'thread_root';
const OWNER = { tenant_id: 't1', created_by: 'u1' };
const SEND_ARGS = JSON.stringify({ to: 'ana@example.com', body: 'Lunch at noon?' });

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

type CallToolMock = jest.Mock<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>;

function makeSource(callTool: CallToolMock): ToolSource {
  const schema = { type: 'object' as const, properties: {} };
  return {
    name: 'mail',
    id: 'mail',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            { name: 'send_note', description: 'Send a note', inputSchema: schema, preload: true },
            {
              name: 'web_search',
              description: 'Search the web',
              inputSchema: schema,
              annotations: { readOnlyHint: true, openWorldHint: true },
              preload: true,
            },
            {
              name: 'read_note',
              description: 'Read a note',
              inputSchema: schema,
              annotations: { readOnlyHint: true, openWorldHint: false },
              preload: true,
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool,
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'mail',
        mcp_server_name: 'mail',
        original_tool_name: params.name,
      }),
  };
}

interface Harness {
  base: SentinelServices;
  callTool: CallToolMock;
  audit: AuditRecordInput[];
  llmCreate: jest.Mock;
  build: (input: {
    unattended: boolean;
    context?: AgentThreadConstructorInput['context'];
    stopAfterToolResponse?: boolean;
    reuseLlm?: boolean;
  }) => { thread: AgentThread; orchestrator: AgentThreadOrchestrator };
}

function makeHarness(
  script: (() => ReturnType<typeof textReplyStream>)[],
  options: { searchProviderAsks?: boolean; searchProvider?: boolean; secrets?: readonly string[] } = {},
): Harness {
  const audit: AuditRecordInput[] = [];
  const base: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: input => {
        audit.push(input);
        return Promise.resolve();
      },
    },
    searchWithoutAsking: () => Promise.resolve(options.searchProviderAsks !== true),
    outboundSecrets: () => Promise.resolve(options.secrets ?? []),
  };
  const callTool: CallToolMock = jest.fn<ReturnType<ToolSource['callTool']>, Parameters<ToolSource['callTool']>>(() =>
    Promise.resolve(toolResultResponse({ text: 'sent' })),
  );
  const llmCreate = jest.fn();
  for (const step of script) {
    llmCreate.mockImplementationOnce(step);
  }
  llmCreate.mockImplementation(() => textReplyStream('All done.'));
  return {
    base,
    audit,
    callTool,
    llmCreate,
    build: input => {
      const services = input.unattended ? forUnattendedRun(base) : base;
      const sentinel = createSentinelHostContext({ ...OWNER, conversation_id: 'c1', services });
      const toolSet = new ToolSet({
        source: makeSource(callTool),
        selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
        preload: true,
        sentinel,
        searchProvider:
          options.searchProviderAsks === true || options.searchProvider === true
            ? { tools: ['web_search'], plumbing_fields: [] }
            : undefined,
      });
      const threadInput: AgentThreadConstructorInput = {
        definition: {
          modelClient: { create: llmCreate, createNonStream: jest.fn() },
          instruction: 'You are running in a test setup.',
          messages: undefined,
          modelParams: undefined,
          responseFormat: undefined,
          iterationLimit: undefined,
          toolSets: undefined,
          modelId: undefined,
          configuredModels: undefined,
        },
        threadId: ROOT_ID,
        title: 'held',
        parent: undefined,
        agentInfo: undefined,
        context: input.context,
        currentContextUsage: undefined,
        preComputedCompletion: undefined,
        sandbox: undefined,
        capabilities: [
          {
            systemToolSets: [toolSet],
            preSendProcessors: undefined,
            preLLMProcessors: undefined,
            preLLMEphemeralProcessors: undefined,
            postToolCallProcessors: undefined,
            toolResponseProcessors: undefined,
            instructionBuilders: undefined,
          },
        ],
        capabilityState: undefined,
        toolCallMemo: undefined,
        taskState: undefined,
        isRequestContinuation: input.context !== undefined,
        sentinel,
        stopAfterToolResponse: input.stopAfterToolResponse,
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
      };
      const thread = new AgentThread(threadInput);
      const orchestrator = new AgentThreadOrchestrator({
        agentThreads: new Map([[thread.threadId, thread]]),
        createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
      });
      return { thread, orchestrator };
    },
  };
}

const sendNoteCall: CallSpec = { id: 'call-send', name: 'send_note', args: SEND_ARGS };

/** The brief: the model asks to send a note, is told it is held, and then writes its summary. */
async function runBrief(h: Harness) {
  const { thread, orchestrator } = h.build({ unattended: true });
  const brief = await runTurn({
    orchestrator,
    sendBatch: [{ type: EventType.USER_MESSAGE, content: 'Morning brief' }],
  });
  return { thread, brief };
}

function heldContext(thread: AgentThread) {
  return thread.toSnapshot().context;
}

function approve(callId: string, scope?: 'once' | 'chat' | 'always') {
  return {
    type: EventType.USER_TOOL_APPROVAL,
    thread_id: ROOT_ID,
    tool_call_id: callId,
    approval: { status: 'allow' as const, ...(scope === undefined ? {} : { scope }) },
  };
}

describe('an unattended run', () => {
  it('holds a call that would ask, finishes without stopping, and never dispatches it', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const { thread, brief } = await runBrief(h);

    expect(h.callTool).not.toHaveBeenCalled();
    expect(brief.result.required_actions).toEqual([]);
    expect(brief.result.root_agent_error).toBeUndefined();
    expect(brief.result.output).toMatchObject({ content: 'All done.' });
    expect(brief.events.map(event => event.type)).not.toContain(EventType.TOOL_EXECUTION_STARTED);
    expect(h.audit).toEqual([
      expect.objectContaining({ outcome: 'logged', description: expect.stringContaining('Held for the owner') }),
    ]);

    const listed = brief.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED);
    expect(listed).toMatchObject({
      type: EventType.TOOL_APPROVAL_REQUIRED,
      tool_calls: [{ id: 'call-send', held: true, can_always_allow: false, tier: 3, expires_at: expect.any(String) }],
    });

    // The model reads that the action is held and goes on to write its summary.
    const secondRequest = JSON.stringify(h.llmCreate.mock.calls[1]?.[0]);
    expect(secondRequest).toContain('needs the owner');
    expect(h.llmCreate).toHaveBeenCalledTimes(2);

    const held = heldContext(thread).flatMap(message =>
      'role' in message && message.role === 'assistant' ? (message.tool_calls ?? []) : [],
    );
    expect(held[0]?.function.arguments).toBe(SEND_ARGS);
    expect(held[0]?.tool_info.held_for_owner).toBeDefined();
    expect(held[0]?.tool_info.is_approval_required).toBe(false);
  });

  it('still runs a read-only tool the owner always allowed, silently', async () => {
    const h = makeHarness([() => toolCallsStream([{ id: 'call-read', name: 'read_note', args: '{}' }])]);
    await h.base.tool_grants.recordToolGrant({ ...OWNER, mcp_server_name: 'mail', tool_name: 'read_note' });
    const { brief } = await runBrief(h);

    expect(h.callTool).toHaveBeenCalledTimes(1);
    expect(brief.events.map(event => event.type)).not.toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(brief.result.required_actions).toEqual([]);
  });

  it('holds a web search the owner set to ask instead of denying it', async () => {
    const h = makeHarness(
      [
        () =>
          toolCallsStream([{ id: 'call-search', name: 'web_search', args: JSON.stringify({ query: 'oslo weather' }) }]),
      ],
      { searchProviderAsks: true },
    );
    const { brief } = await runBrief(h);

    expect(h.callTool).not.toHaveBeenCalled();
    expect(brief.result.required_actions).toEqual([]);
    expect(brief.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [{ id: 'call-search', held: true, can_always_allow: false }],
    });
    expect(JSON.stringify(h.llmCreate.mock.calls[1]?.[0])).not.toContain('denied');
  });

  it('holds at most twenty actions a chat and tells the model about the rest', async () => {
    const calls = Array.from({ length: 22 }, (_, index) => ({
      id: `call-${String(index)}`,
      name: 'send_note',
      args: JSON.stringify({ to: `person${String(index)}@example.com` }),
    }));
    const h = makeHarness([() => toolCallsStream(calls)]);
    const { brief } = await runBrief(h);

    const listed = brief.events.flatMap(event =>
      event.type === EventType.TOOL_APPROVAL_REQUIRED
        ? event.tool_calls.filter(call => call.held === true).map(call => call.id)
        : [],
    );
    expect(listed).toHaveLength(20);
    const notSaved = brief.events.flatMap(event =>
      event.type === EventType.TOOL_APPROVAL_REQUIRED
        ? event.tool_calls.filter(call => call.not_saved === 'too_many').map(call => call.id)
        : [],
    );
    expect(notSaved).toEqual(['call-20', 'call-21']);
    expect(JSON.stringify(h.llmCreate.mock.calls[1]?.[0])).toContain('Too many actions are already waiting');
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('holds one of two identical calls and treats the repeat as a no-op that neither fails nor stops the run', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall, { ...sendNoteCall, id: 'call-send-again' }])]);
    const { thread, brief } = await runBrief(h);

    const listed = brief.events.flatMap(event =>
      event.type === EventType.TOOL_APPROVAL_REQUIRED ? event.tool_calls.map(call => call.id) : [],
    );
    expect(listed).toEqual(['call-send']);
    expect(brief.result.root_agent_error).toBeUndefined();
    expect(brief.result.output).toMatchObject({ content: 'All done.' });
    expect(h.audit).toHaveLength(1);
    // The repeat is not something the owner can answer.
    const replay = h.build({ unattended: false, context: heldContext(thread), stopAfterToolResponse: true });
    await expect(
      runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send-again')] }),
    ).rejects.toBeInstanceOf(InvalidAgentSendInputError);
  });

  it('holds the same call in an attended chat as a pause, so an owner follow-up asks as usual', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const { orchestrator } = h.build({ unattended: false });
    const turn = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'Send it now' }],
    });
    expect(turn.result.required_actions).toMatchObject([{ type: EventType.TOOL_APPROVAL_REQUIRED }]);
    expect(h.callTool).not.toHaveBeenCalled();
  });
});

describe('approving a held action later', () => {
  async function heldBrief(h: Harness) {
    const { thread } = await runBrief(h);
    return heldContext(thread);
  }

  it('runs the exact stored call once, with no model call, and a repeat answer does nothing', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const modelCallsBefore = h.llmCreate.mock.calls.length;

    const replay = h.build({ unattended: false, context, stopAfterToolResponse: true });
    const turn = await runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send')] });

    const heldToken = context.flatMap(message =>
      'role' in message && message.role === 'assistant' ? (message.tool_calls ?? []) : [],
    )[0]?.tool_info.approval_token_id;
    // The token minted when the call was held is the one the run redeems.
    expect(heldToken).toEqual(expect.any(String));
    expect(await h.base.token_store.peek({ ...OWNER, token_id: heldToken ?? '' })).toBeUndefined();
    expect(h.callTool).toHaveBeenCalledTimes(1);
    expect(h.callTool).toHaveBeenCalledWith(
      { name: 'send_note', arguments: JSON.parse(SEND_ARGS) },
      expect.objectContaining({ status: 'allow' }),
      expect.anything(),
    );
    expect(h.llmCreate.mock.calls.length).toBe(modelCallsBefore);
    expect(turn.result.root_agent_error).toBeUndefined();
    expect(turn.result.required_actions).toEqual([]);
    expect(turn.events.map(event => event.type)).toEqual(
      expect.arrayContaining([EventType.MODEL_MESSAGE, EventType.TOOL_RESPONSE_V2]),
    );

    // The same answer again finds nothing waiting, so the call cannot run twice.
    const again = h.build({
      unattended: false,
      context: replay.thread.toSnapshot().context,
      stopAfterToolResponse: true,
    });
    await expect(
      runTurn({ orchestrator: again.orchestrator, sendBatch: [approve('call-send')] }),
    ).rejects.toBeInstanceOf(InvalidAgentSendInputError);
    expect(h.callTool).toHaveBeenCalledTimes(1);
  });

  it('drops a denied action: nothing runs and no model call is made', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const modelCallsBefore = h.llmCreate.mock.calls.length;

    const replay = h.build({ unattended: false, context, stopAfterToolResponse: true });
    const turn = await runTurn({
      orchestrator: replay.orchestrator,
      sendBatch: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: ROOT_ID,
          tool_call_id: 'call-send',
          approval: { status: 'deny' },
        },
      ],
    });

    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.llmCreate.mock.calls.length).toBe(modelCallsBefore);
    expect(turn.result.output).toMatchObject({ content: 'Denied. Nothing was done.' });
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'denied', description: expect.stringContaining('Turned down') });
  });

  it('refuses an expired hold and leaves the chat as it was', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const stale = context.map(message =>
      'role' in message && message.role === 'assistant'
        ? {
            ...message,
            tool_calls: message.tool_calls?.map(call => ({
              ...call,
              tool_info: {
                ...call.tool_info,
                held_for_owner: { expires_at: new Date(Date.now() - 1000).toISOString() },
              },
            })),
          }
        : message,
    );

    const replay = h.build({ unattended: false, context: stale, stopAfterToolResponse: true });
    await expect(
      runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send')] }),
    ).rejects.toMatchObject({
      name: 'HeldActionRefusedError',
      reason: 'expired',
    });
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'denied', description: expect.stringContaining('expired') });
  });

  it('refuses when the hold-time token was already used', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const held = context.flatMap(message =>
      'role' in message && message.role === 'assistant' ? (message.tool_calls ?? []) : [],
    )[0];
    const tokenId = held?.tool_info.approval_token_id;
    if (tokenId === undefined || tokenId === null) {
      throw new Error('expected the held call to carry a token');
    }
    await h.base.token_store.redeem({ ...OWNER, token_id: tokenId });

    const replay = h.build({ unattended: false, context, stopAfterToolResponse: true });
    await expect(
      runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send')] }),
    ).rejects.toMatchObject({
      reason: 'expired',
    });
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('refuses when what the call would do no longer matches what was held', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const changed = context.map(message =>
      'role' in message && message.role === 'assistant'
        ? {
            ...message,
            tool_calls: message.tool_calls?.map(call => ({
              ...call,
              tool_info: {
                ...call.tool_info,
                tier3_card:
                  call.tool_info.tier3_card === undefined || call.tool_info.tier3_card === null
                    ? call.tool_info.tier3_card
                    : { ...call.tool_info.tier3_card, recipient: 'someone-else@example.com' },
              },
            })),
          }
        : message,
    );

    const replay = h.build({ unattended: false, context: changed, stopAfterToolResponse: true });
    await expect(
      runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send')] }),
    ).rejects.toMatchObject({
      reason: 'changed',
    });
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it('records a standing grant when the owner picks Always allow on a read-only tool', async () => {
    const h = makeHarness([() => toolCallsStream([{ id: 'call-read', name: 'read_note', args: '{}' }])]);
    const { thread, brief } = await runBrief(h);
    expect(brief.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED)).toMatchObject({
      tool_calls: [{ id: 'call-read', held: true, can_always_allow: true }],
    });
    const grantKey = { ...OWNER, mcp_server_name: 'mail', tool_name: 'read_note' };
    expect(await h.base.tool_grants.hasToolGrant(grantKey)).toBe(false);

    const replay = h.build({ unattended: false, context: heldContext(thread), stopAfterToolResponse: true });
    await runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-read', 'always')] });

    expect(await h.base.tool_grants.hasToolGrant(grantKey)).toBe(true);
    expect(h.callTool).toHaveBeenCalledTimes(1);
    // The grant made the call silent, so no dispatch row follows: the approval is recorded at the answer.
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'approved' });
  });

  it('does not offer a chat-wide approval on a held action', async () => {
    const h = makeHarness([() => toolCallsStream([sendNoteCall])]);
    const context = await heldBrief(h);
    const replay = h.build({ unattended: false, context, stopAfterToolResponse: true });
    await expect(
      runTurn({ orchestrator: replay.orchestrator, sendBatch: [approve('call-send', 'chat')] }),
    ).rejects.toThrow('chat-scoped approval is not available');
  });
});

describe('audit rows for a held web search', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlMTIzNDU2'].join('.');
  const caught = [
    ['a signed token', jwt],
    ['a card number', 'refund to 4111 1111 1111 1111'],
    ['a password label', 'password: hunter2hunter2'],
  ] as const;

  function searchCall(query: string): CallSpec {
    return { id: 'call-search', name: 'web_search', args: JSON.stringify({ query }) };
  }

  function answer(status: 'allow' | 'deny') {
    return {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: ROOT_ID,
      tool_call_id: 'call-search',
      approval: { status },
    };
  }

  function descriptions(h: Harness): string[] {
    return h.audit.map(record => record.description);
  }

  it.each(caught)('names the rule, not the text, for %s held in a scheduled run', async (_label, query) => {
    for (const status of ['allow', 'deny'] as const) {
      const h = makeHarness([() => toolCallsStream([searchCall(query)])], { searchProvider: true });
      const { thread } = await runBrief(h);
      const replay = h.build({ unattended: false, context: heldContext(thread), stopAfterToolResponse: true });
      await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer(status)] });
      expect(descriptions(h).length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(descriptions(h))).not.toContain(query);
      expect(descriptions(h)[0]).toContain('Held because');
    }
  });

  it.each(caught)('names the rule, not the text, for %s held in an attended chat', async (_label, query) => {
    for (const status of ['allow', 'deny'] as const) {
      const h = makeHarness([() => toolCallsStream([searchCall(query)])], { searchProvider: true });
      const { orchestrator, thread } = h.build({ unattended: false });
      await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }] });
      const replay = h.build({
        unattended: false,
        context: heldContext(thread),
        stopAfterToolResponse: true,
      });
      await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer(status)] });
      expect(descriptions(h).length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(descriptions(h))).not.toContain(query);
    }
  });

  it.each([false, true])('keeps a held key out of the row and the card when searches ask: %s', async asks => {
    const key = 'synthetic-provider-key-000111';
    const h = makeHarness([() => toolCallsStream([searchCall(`debug ${key}`)])], {
      searchProvider: true,
      searchProviderAsks: asks,
      secrets: [key],
    });
    const { thread, brief } = await runBrief(h);
    const replay = h.build({ unattended: false, context: heldContext(thread), stopAfterToolResponse: true });
    await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer('allow')] });
    const listed = brief.events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED);
    expect(JSON.stringify([descriptions(h), listed])).not.toContain(key);
  });

  it('keeps the query out of the row when searches are set to ask', async () => {
    const h = makeHarness([() => toolCallsStream([searchCall('oslo weather in march')])], { searchProviderAsks: true });
    const { thread } = await runBrief(h);
    const replay = h.build({ unattended: false, context: heldContext(thread), stopAfterToolResponse: true });
    await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer('deny')] });
    expect(JSON.stringify(descriptions(h))).not.toContain('oslo weather');
    expect(descriptions(h).at(-1)).toContain('searches are set to ask');
  });
});

describe('audit rows for a web search held before its audit text was stored', () => {
  const key = 'wsk-live-synthetic000111222333';
  const cardNumber = '4111 1111 1111 1111';
  const query = `how do I rotate ${key} safely, refund to ${cardNumber}`;
  const savedReasons = ['Held for approval: it contains a secret this server holds.', null] as const;

  // A hold stored by the earlier release: the query in plain_what, the reason in why_asked_again,
  // and no audit_description.
  function savedByEarlierRelease(
    context: ReturnType<typeof heldContext>,
    whyAskedAgain: string | null,
  ): ReturnType<typeof heldContext> {
    return context.map(message => {
      if (!('role' in message) || message.role !== 'assistant' || message.tool_calls === undefined) {
        return message;
      }
      return {
        ...message,
        tool_calls: message.tool_calls.map(call => {
          const card = call.tool_info.tier3_card;
          if (call.id !== 'call-search' || card === null || card === undefined) {
            return call;
          }
          const info = {
            ...call.tool_info,
            tier3_card: {
              ...card,
              plain_what: `Search the web through mail for: ${query}`,
              why_asked_again: whyAskedAgain,
            },
          };
          delete info.audit_description;
          return { ...call, tool_info: info };
        }),
      };
    });
  }

  function answer(status: 'allow' | 'deny') {
    return {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: ROOT_ID,
      tool_call_id: 'call-search',
      approval: { status },
    };
  }

  function expectNoCaughtText(h: Harness): void {
    const rows = JSON.stringify(h.audit.map(record => record.description));
    expect(rows).not.toContain(key);
    expect(rows).not.toContain(cardNumber);
    expect(rows).not.toContain('rotate');
  }

  const cases = savedReasons.flatMap(why => (['allow', 'deny'] as const).map(status => [status, why] as const));

  it.each(cases)('answered %s in an attended chat (saved reason %s)', async (status, why) => {
    const h = makeHarness(
      [() => toolCallsStream([{ id: 'call-search', name: 'web_search', args: JSON.stringify({ query }) }])],
      {
        searchProvider: true,
        secrets: [key],
      },
    );
    const { orchestrator, thread } = h.build({ unattended: false });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }] });
    const replay = h.build({
      unattended: false,
      context: savedByEarlierRelease(heldContext(thread), why),
      stopAfterToolResponse: true,
    });
    await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer(status)] });

    expect(h.audit.length).toBeGreaterThanOrEqual(1);
    expectNoCaughtText(h);
    expect(h.audit.at(-1)?.description).toContain('Search the web through mail. Held because');
  });

  it.each(cases)('answered %s after a scheduled run held it (saved reason %s)', async (status, why) => {
    const h = makeHarness(
      [() => toolCallsStream([{ id: 'call-search', name: 'web_search', args: JSON.stringify({ query }) }])],
      {
        searchProvider: true,
        secrets: [key],
      },
    );
    const { thread } = await runBrief(h);
    const replay = h.build({
      unattended: false,
      context: savedByEarlierRelease(heldContext(thread), why),
      stopAfterToolResponse: true,
    });
    await runTurn({ orchestrator: replay.orchestrator, sendBatch: [answer(status)] });

    expect(h.audit.length).toBeGreaterThanOrEqual(2);
    expectNoCaughtText(h);
    expect(h.audit.at(-1)?.description).toContain('Search the web through mail. Held because');
  });
});

describe('the per-reply call cap in an unattended run (owner ruling, 2026-10-19)', () => {
  it('merges 22 identical reads into one call, which runs once', async () => {
    const calls = Array.from({ length: 22 }, (_, index) => ({
      id: `call-read-${String(index)}`,
      name: 'read_note',
      args: '{}',
    }));
    const h = makeHarness([() => toolCallsStream(calls)]);
    await h.base.tool_grants.recordToolGrant({ ...OWNER, mcp_server_name: 'mail', tool_name: 'read_note' });
    const { brief } = await runBrief(h);

    expect(h.callTool).toHaveBeenCalledTimes(1);
    expect(brief.result.root_agent_error).toBeUndefined();
    expect(brief.result.output).toMatchObject({ content: 'All done.' });
  });

  it('queues 15 distinct held sends without tripping the cap', async () => {
    const calls = Array.from({ length: 15 }, (_, index) => ({
      id: `call-send-${String(index)}`,
      name: 'send_note',
      args: JSON.stringify({ to: `person${String(index)}@example.com`, body: 'Lunch at noon?' }),
    }));
    const h = makeHarness([() => toolCallsStream(calls)]);
    const { brief } = await runBrief(h);

    const listed = brief.events.flatMap(event =>
      event.type === EventType.TOOL_APPROVAL_REQUIRED
        ? event.tool_calls.filter(call => call.held === true).map(call => call.id)
        : [],
    );
    expect(listed).toHaveLength(15);
    expect(h.callTool).not.toHaveBeenCalled();
    expect(brief.result.root_agent_error).toBeUndefined();
    expect(brief.result.output).toMatchObject({ content: 'All done.' });
  });

  it('still stops the run when more than 8 calls would run at once', async () => {
    const calls = Array.from({ length: 9 }, (_, index) => ({
      id: `call-read-${String(index)}`,
      name: 'read_note',
      args: JSON.stringify({ note: `n${String(index)}` }),
    }));
    const h = makeHarness([() => toolCallsStream(calls)]);
    await h.base.tool_grants.recordToolGrant({ ...OWNER, mcp_server_name: 'mail', tool_name: 'read_note' });
    const { brief } = await runBrief(h);

    expect(h.callTool).not.toHaveBeenCalled();
    expect(brief.result.root_agent_error?.error).toBe(TOO_MANY_TOOL_CALLS_MESSAGE);
  });
});
