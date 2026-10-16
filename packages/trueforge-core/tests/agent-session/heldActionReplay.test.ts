/**
 * A scheduled run held an action; the owner answers later through the ordinary tool approval input.
 * Driven through SessionHandle and the session store, so the held call survives its stored snapshot.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { createSentinelHostContext } from '../../src/core/permissions';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const SEND_ARGS = JSON.stringify({ to: 'ana@example.com', body: 'Lunch at noon?' });
const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* sendNoteStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = [
    { id: 'call-send', type: 'function' as const, function: { name: 'send_note', arguments: SEND_ARGS } },
  ];
  yield {
    id: 'chunk-send',
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

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* textStream(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-text',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

async function setup() {
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: 'sent' })));
  const source: ToolSource = {
    name: 'mail',
    id: 'mail',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'send_note',
              description: 'Send a note',
              inputSchema: { type: 'object' as const, properties: {} },
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
  const create = jest.fn();
  create.mockImplementationOnce(() => sendNoteStream());
  create.mockImplementation(() => textStream('Brief done.'));
  const base = makeTestResolver({ modelClient: makeMockILLM({ create }) });
  // The mail connector is built per turn from that turn's Sentinel services, as the server does.
  const resolver: ITurnResourceResolver = {
    get logger() {
      return base.logger;
    },
    createTracing: () => base.createTracing(),
    resolveAgentSpec: input => base.resolveAgentSpec(input),
    resolveSandbox: input => base.resolveSandbox(input),
    resolveAgentDefinition: async input => {
      const resolved = await base.resolveAgentDefinition(input);
      const toolSet = new ToolSet({
        source,
        selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
        preload: true,
        sentinel: createSentinelHostContext({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          conversation_id: input.session_id,
          services: input.sentinel_services,
        }),
      });
      return {
        ...resolved,
        extraCapabilities: [
          ...(resolved.extraCapabilities ?? []),
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
      };
    },
    close: () => base.close(),
  };
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'brief',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: 'run-1',
    source: { type: 'schedule', id: 'sched-1', run_id: 'run-1' },
  });
  const run = async (
    input: Parameters<typeof session.createTurn>[0]['input'],
    options: { unattended?: boolean; stop?: boolean } = {},
  ) => {
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input,
      signal: new AbortController().signal,
      resolver,
      ...(options.unattended === true ? { unattended: true } : {}),
      ...(options.stop === true ? { stop_after_tool_response: true } : {}),
    });
    for await (const event of turn.stream()) {
      void event;
    }
    return turn;
  };
  const approval = (status: 'allow' | 'deny') => [
    { type: EventType.USER_TOOL_APPROVAL, thread_id: 'main', tool_call_id: 'call-send', approval: { status } },
  ];
  return { session, run, approval, callTool, create };
}

describe('a scheduled run that held an action', () => {
  it('finishes without pausing, then runs exactly the stored call once when the owner approves', async () => {
    const { session, run, approval, callTool, create } = await setup();
    const brief = await run([{ type: EventType.USER_MESSAGE, content: 'Morning brief' }], { unattended: true });

    const finished = await session.getTurn(brief.id);
    expect(finished?.state).toMatchObject({ status: 'done', required_actions: [] });
    expect(callTool).not.toHaveBeenCalled();
    expect(await session.answersOnlyHeldActions({ previous_turn_id: undefined, input: approval('allow') })).toBe(true);

    const modelCalls = create.mock.calls.length;
    const replay = await run(approval('allow'), { stop: true });

    expect(replay.state.status).toBe('done');
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      { name: 'send_note', arguments: JSON.parse(SEND_ARGS) as unknown },
      expect.objectContaining({ status: 'allow' }),
      expect.anything(),
    );
    expect(create.mock.calls.length).toBe(modelCalls);

    // The answer is on record: a second one is no longer about a waiting action, and is only replayed.
    expect(await session.answersOnlyHeldActions({ previous_turn_id: undefined, input: approval('allow') })).toBe(false);
    await expect(run(approval('allow'))).rejects.toThrow('no pending approval');
    expect(callTool).toHaveBeenCalledTimes(1);
    const again = await session.classifyApprovalResubmission({
      previous_turn_id: undefined,
      decisions: approval('allow'),
    });
    expect(again.outcome).toBe('replay');
    const contradicting = await session.classifyApprovalResubmission({
      previous_turn_id: undefined,
      decisions: approval('deny'),
    });
    expect(contradicting.outcome).toBe('conflict');
  });

  it('drops a denied action and asks the model nothing', async () => {
    const { run, approval, callTool, create } = await setup();
    await run([{ type: EventType.USER_MESSAGE, content: 'Morning brief' }], { unattended: true });
    const modelCalls = create.mock.calls.length;

    const replay = await run(approval('deny'), { stop: true });

    expect(replay.state.status).toBe('done');
    expect(callTool).not.toHaveBeenCalled();
    expect(create.mock.calls.length).toBe(modelCalls);
  });

  it('asks as usual when the owner follows up in the same chat, instead of holding', async () => {
    const { session, run, create, callTool } = await setup();
    await run([{ type: EventType.USER_MESSAGE, content: 'Morning brief' }], { unattended: true });
    create.mockImplementationOnce(() => sendNoteStream());

    const followUp = await run([{ type: EventType.USER_MESSAGE, content: 'Send Ana the note now' }]);

    const finished = await session.getTurn(followUp.id);
    expect(finished?.state).toMatchObject({
      status: 'done',
      required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }],
    });
    expect(callTool).not.toHaveBeenCalled();
  });
});
