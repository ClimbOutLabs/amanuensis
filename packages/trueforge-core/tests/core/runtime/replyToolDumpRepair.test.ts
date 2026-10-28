/**
 * A reply that carries a tool result pasted as raw data instead of words. The saved reply is
 * repaired: the dump is swapped for the result's own written line when it has one, and taken
 * out when it has none. What streamed live is not rewritten; these tests check what was saved.
 * The helper's own pins cover the matching edges (trimmed copies, fences, asked-for JSON).
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  assistantMessageContentToStringForSubAgent,
  internalSystemMessage,
} from '../../../src/core/runtime/contextUtils';
import {
  messageAsksForJson,
  repairToolResultDump,
  TOOL_RESULT_DUMP_FALLBACK_LINE,
  turnToolResultShapes,
  type TurnToolResultShape,
} from '../../../src/core/runtime/replyToolDumpRepair';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { isRecord } from '../../../src/core/util/records';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const SPACE_SUMMARY = 'Created space "Test Kitchen Notes" (revision 1).';

const SPACE_RESULT_OBJECT = {
  summary: SPACE_SUMMARY,
  name: 'Test Kitchen Notes',
  link: '/spaces/Test%20Kitchen%20Notes',
  purpose: 'Personal notes for cooking experiments',
  status: 'active',
  format: 'markdown',
  revision: 1,
  created_at: '2026-10-27T14:32:10.000Z',
  updated_at: '2026-10-27T14:32:10.000Z',
};
const SPACE_RESULT = JSON.stringify(SPACE_RESULT_OBJECT);

/** The live specimen's shape: the same result pasted with a few keys dropped. */
const TRIMMED_DUMP = JSON.stringify({
  name: 'Test Kitchen Notes',
  link: '/spaces/Test%20Kitchen%20Notes',
  purpose: 'Personal notes for cooking experiments',
  status: 'active',
  revision: 1,
  updated_at: '2026-10-27T14:32:10.000Z',
});

/** The same result as it actually reaches the model: wrapped in the tool response envelope. */
const SPACE_ENVELOPE = JSON.stringify({
  schema_version: 'tool.response.v2',
  outcome: { disposition: 'executed_ok' },
  result: SPACE_RESULT_OBJECT,
});

/** A result with no written line of its own. */
const PLAIN_RESULT_OBJECT = {
  name: 'Test Kitchen Notes',
  link: '/spaces/Test%20Kitchen%20Notes',
  purpose: 'Personal notes for cooking experiments',
  status: 'active',
  revision: 3,
  updated_at: '2026-10-27T15:01:00.000Z',
};
const PLAIN_RESULT = JSON.stringify(PLAIN_RESULT_OBJECT);

function shapeOf(toolName: string, result: Record<string, unknown>): TurnToolResultShape {
  const summary = result['summary'];
  return {
    toolName,
    keys: new Set(Object.keys(result)),
    values: result,
    summary: typeof summary === 'string' ? summary : undefined,
  };
}

describe('messageAsksForJson', () => {
  it('is true when the person asks for the JSON or the raw result', () => {
    expect(messageAsksForJson('Show me the new space as JSON.')).toBe(true);
    expect(messageAsksForJson('Give me the raw result, please.')).toBe(true);
    expect(messageAsksForJson('Print the json for that call.')).toBe(true);
  });

  it('is false for an ordinary request', () => {
    expect(messageAsksForJson('Create a space for my recipes.')).toBe(false);
    expect(messageAsksForJson('What is in the Test Kitchen Notes space?')).toBe(false);
  });
});

describe('turnToolResultShapes', () => {
  const callMessage = (id: string, name: string): ContextMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: '{}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'spaces',
          mcp_server_name: 'spaces',
          original_tool_name: name,
          is_approval_required: false,
          is_client_side: false,
        },
      },
    ],
  });

  it('reads this turn’s results with their tool names and summary lines', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'Make the space.' },
      callMessage('call-1', 'create_space'),
      { role: 'tool', tool_call_id: 'call-1', content: SPACE_RESULT },
    ];
    const shapes = turnToolResultShapes(context);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.toolName).toBe('create_space');
    expect(shapes[0]?.summary).toBe(SPACE_SUMMARY);
    expect(shapes[0]?.keys).toEqual(new Set(Object.keys(SPACE_RESULT_OBJECT)));
    expect(shapes[0]?.values).toEqual(SPACE_RESULT_OBJECT);
  });

  it('unwraps the tool response envelope, so the shape is the result inside it', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'Make the space.' },
      callMessage('call-1', 'create_space'),
      { role: 'tool', tool_call_id: 'call-1', content: SPACE_ENVELOPE },
    ];
    const shapes = turnToolResultShapes(context);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.toolName).toBe('create_space');
    expect(shapes[0]?.summary).toBe(SPACE_SUMMARY);
    expect(shapes[0]?.keys).toEqual(new Set(Object.keys(SPACE_RESULT_OBJECT)));
  });

  it('stops at the person’s latest message, so an earlier turn’s results do not count', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'Make the space.' },
      callMessage('call-1', 'create_space'),
      { role: 'tool', tool_call_id: 'call-1', content: SPACE_RESULT },
      { role: 'assistant', content: 'Your space is ready.' },
      { role: 'user', content: 'Now read it back.' },
      callMessage('call-2', 'read_space'),
      { role: 'tool', tool_call_id: 'call-2', content: PLAIN_RESULT },
    ];
    const shapes = turnToolResultShapes(context);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.toolName).toBe('read_space');
    expect(shapes[0]?.summary).toBeUndefined();
  });

  it('a host note in the turn does not move the boundary, and non-object results are skipped', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'Make the space, then check the time.' },
      internalSystemMessage('A host note.'),
      callMessage('call-1', 'create_space'),
      { role: 'tool', tool_call_id: 'call-1', content: SPACE_RESULT },
      callMessage('call-2', 'get_current_datetime'),
      { role: 'tool', tool_call_id: 'call-2', content: '"2026-10-27T15:00:00.000Z"' },
      callMessage('call-3', 'list_spaces'),
      { role: 'tool', tool_call_id: 'call-3', content: 'not json at all' },
    ];
    const shapes = turnToolResultShapes(context);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.toolName).toBe('create_space');
  });
});

describe('repairToolResultDump', () => {
  const spaceShape = shapeOf('create_space', SPACE_RESULT_OBJECT);
  const plainShape = shapeOf('read_space', PLAIN_RESULT_OBJECT);

  it('repairs the specimen: a trimmed copy after one prose sentence becomes the prose plus the result’s own line', () => {
    const repair = repairToolResultDump({
      text: `Your space is ready.\n\n${TRIMMED_DUMP}`,
      results: [spaceShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(`Your space is ready.\n\n${SPACE_SUMMARY}`);
    expect(repair?.toolName).toBe('create_space');
  });

  it('repairs a dump that kept the whole tool response envelope around the result', () => {
    const repair = repairToolResultDump({
      text: `Your space is ready.\n\n${SPACE_ENVELOPE}`,
      results: [spaceShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(`Your space is ready.\n\n${SPACE_SUMMARY}`);
    expect(repair?.toolName).toBe('create_space');
  });

  it('repairs a full byte-for-byte dump the same way', () => {
    const repair = repairToolResultDump({
      text: `Here is the space.\n\n${SPACE_RESULT}`,
      results: [spaceShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(`Here is the space.\n\n${SPACE_SUMMARY}`);
  });

  it('repairs a dump spread over many lines', () => {
    const pretty = JSON.stringify(SPACE_RESULT_OBJECT, null, 2);
    const repair = repairToolResultDump({
      text: `Done.\n\n${pretty}`,
      results: [spaceShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(`Done.\n\n${SPACE_SUMMARY}`);
  });

  it('takes a dump with no written line out and leaves the prose standing', () => {
    const repair = repairToolResultDump({
      text: `Here is the space as it stands.\n\n${PLAIN_RESULT}\n\nAnything else?`,
      results: [plainShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe('Here is the space as it stands.\n\nAnything else?');
    expect(repair?.toolName).toBe('read_space');
  });

  it('saves the plain fallback line when the whole reply was a dump with no written line', () => {
    const repair = repairToolResultDump({
      text: PLAIN_RESULT,
      results: [plainShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(TOOL_RESULT_DUMP_FALLBACK_LINE);
  });

  it('saves the result’s own line when the whole reply was a dump that has one', () => {
    const repair = repairToolResultDump({
      text: SPACE_RESULT,
      results: [spaceShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(SPACE_SUMMARY);
  });

  it('never touches a JSON object inside a code fence', () => {
    const text = `The raw result was:\n\n\`\`\`json\n${SPACE_RESULT}\n\`\`\``;
    expect(repairToolResultDump({ text, results: [spaceShape], personAskedForJson: false })).toBeUndefined();
  });

  it('never touches a reply when the person asked for the data in that shape', () => {
    const text = `Here it is.\n\n${SPACE_RESULT}`;
    expect(repairToolResultDump({ text, results: [spaceShape], personAskedForJson: true })).toBeUndefined();
  });

  it('leaves an object that matches no result from this turn alone', () => {
    const other = JSON.stringify({ alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 });
    expect(
      repairToolResultDump({ text: `Look.\n\n${other}`, results: [spaceShape], personAskedForJson: false }),
    ).toBeUndefined();
    expect(repairToolResultDump({ text: TRIMMED_DUMP, results: [], personAskedForJson: false })).toBeUndefined();
  });

  it('needs at least four matching keys and two thirds of the object’s keys', () => {
    // Five of eight keys match: under two thirds, so the object is the model's own.
    const mostlyOther = JSON.stringify({
      name: 'Test Kitchen Notes',
      link: '/spaces/Test%20Kitchen%20Notes',
      purpose: 'Personal notes for cooking experiments',
      status: 'active',
      revision: 1,
      extra_one: true,
      extra_two: true,
      extra_three: true,
    });
    expect(
      repairToolResultDump({ text: mostlyOther, results: [spaceShape], personAskedForJson: false }),
    ).toBeUndefined();
    // Three matching keys is never enough, however clean the rest is.
    const threeKeys = JSON.stringify({ name: 'Test Kitchen Notes', status: 'active', revision: 1 });
    expect(repairToolResultDump({ text: threeKeys, results: [spaceShape], personAskedForJson: false })).toBeUndefined();
  });

  it('leaves prose braces that are not JSON alone', () => {
    const text = 'Use {name} and {count} where the values go.';
    expect(repairToolResultDump({ text, results: [spaceShape], personAskedForJson: false })).toBeUndefined();
  });

  it('repairs two dumps in one reply, telling near-identical results apart by their values', () => {
    // The read result carries the same keys as the write result, with a later revision and
    // time. The first dump carries the write's values, the second the read's, and each is
    // repaired against its own result: the first becomes the write's line, the second goes.
    const repair = repairToolResultDump({
      text: `First:\n\n${TRIMMED_DUMP}\n\nSecond:\n\n${PLAIN_RESULT}`,
      results: [spaceShape, plainShape],
      personAskedForJson: false,
    });
    expect(repair?.text).toBe(`First:\n\n${SPACE_SUMMARY}\n\nSecond:`);
  });
});

type CallSpec = { id: string; name: string; args: Record<string, unknown> };

function rawCall(spec: CallSpec): RawToolCall {
  return {
    id: spec.id,
    type: 'function',
    function: { name: spec.name, arguments: JSON.stringify(spec.args) },
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* replyStream(input: {
  calls?: CallSpec[];
  text?: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls = (input.calls ?? []).map(rawCall);
  if (input.text !== undefined) {
    yield {
      id: 'chunk-text',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: input.text }, finish_reason: null }],
    };
  }
  if (calls.length > 0) {
    yield {
      id: 'chunk-calls',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) },
          finish_reason: null,
        },
      ],
    };
  }
  return {
    output: {
      role: 'assistant',
      content: input.text ?? null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    },
    usage: getEmptyUsage(),
    finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
  };
}

function makeToolSet() {
  const toolSet = makeMockIMCPServer({
    name: 'spaces',
    preload: true,
    tools: [
      {
        name: 'create_space',
        description: 'Make a space',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        preload: true,
      },
      {
        name: 'read_space',
        description: 'Read a space',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest
    .mocked(toolSet.callTool)
    .mockImplementation((params: CallToolRequest['params']) =>
      Promise.resolve(toolResultResponse({ text: params.name === 'create_space' ? SPACE_RESULT : PLAIN_RESULT })),
    );
  return toolSet;
}

function makeThread(input: { toolSet: IToolSet; create: ILLM['create']; context?: ContextMessage[] }) {
  const logger = makeSilentLogger();
  const info = jest.spyOn(logger, 'info');
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger,
    definition: {
      modelClient: { create: input.create, createNonStream: jest.fn() },
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [input.toolSet],
    },
    context: input.context ?? [{ role: 'user', content: 'Please make a space called Test Kitchen Notes.' }],
  });
  return { thread, info };
}

async function drain(thread: AgentThread): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function savedReply(thread: AgentThread): string {
  const assistants = thread.toSnapshot().context.filter(message => 'role' in message && message.role === 'assistant');
  const last = assistants.at(-1);
  return last === undefined ? '' : assistantMessageContentToStringForSubAgent(last.content);
}

function streamedText(events: unknown[]): string {
  return events
    .map(event => (isRecord(event) && event['type'] === EventType.MODEL_MESSAGE_DELTA ? event['content'] : undefined))
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

describe('a reply that dumps a tool result', () => {
  it('saves the prose plus the result’s own line, logs the repair, and leaves what streamed alone', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'call-1', name: 'create_space', args: { name: 'Test Kitchen Notes' } }] })
        : replyStream({ text: `Your space is ready.\n\n${TRIMMED_DUMP}` });
    });
    const { thread, info } = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(savedReply(thread)).toBe(`Your space is ready.\n\n${SPACE_SUMMARY}`);
    expect(info).toHaveBeenCalledWith(
      'Repaired a saved reply that carried a tool result as raw data',
      expect.objectContaining({ tool: 'create_space' }),
    );
    // The repair is to the saved reply only: the dump still streamed live.
    expect(streamedText(events)).toContain(TRIMMED_DUMP);
  });

  it('saves the prose with the dump taken out when the result has no written line', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'call-1', name: 'read_space', args: { name: 'Test Kitchen Notes' } }] })
        : replyStream({ text: `Here is the space as it stands.\n\n${PLAIN_RESULT}\n\nAnything else?` });
    });
    const { thread } = makeThread({
      toolSet,
      create,
      context: [{ role: 'user', content: 'Read the Test Kitchen Notes space back to me.' }],
    });
    await drain(thread);

    expect(savedReply(thread)).toBe('Here is the space as it stands.\n\nAnything else?');
  });

  it('saves the plain fallback line when the whole reply is a dump with no written line', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'call-1', name: 'read_space', args: { name: 'Test Kitchen Notes' } }] })
        : replyStream({ text: PLAIN_RESULT });
    });
    const { thread } = makeThread({
      toolSet,
      create,
      context: [{ role: 'user', content: 'Read the Test Kitchen Notes space back to me.' }],
    });
    await drain(thread);

    expect(savedReply(thread)).toBe(TOOL_RESULT_DUMP_FALLBACK_LINE);
  });

  it('leaves the saved reply alone when the person asked for the JSON', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'call-1', name: 'create_space', args: { name: 'Test Kitchen Notes' } }] })
        : replyStream({ text: `Here it is.\n\n${SPACE_RESULT}` });
    });
    const { thread, info } = makeThread({
      toolSet,
      create,
      context: [{ role: 'user', content: 'Make the space and show me the result as JSON.' }],
    });
    await drain(thread);

    expect(savedReply(thread)).toBe(`Here it is.\n\n${SPACE_RESULT}`);
    expect(info).not.toHaveBeenCalledWith(
      'Repaired a saved reply that carried a tool result as raw data',
      expect.anything(),
    );
  });

  it('leaves a dump of an earlier turn’s result alone', async () => {
    const toolSet = makeToolSet();
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({ text: `It said this.\n\n${TRIMMED_DUMP}` }),
    );
    const context: ContextMessage[] = [
      { role: 'user', content: 'Please make a space called Test Kitchen Notes.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'old-call',
            type: 'function',
            function: { name: 'create_space', arguments: '{"name":"Test Kitchen Notes"}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'spaces',
              mcp_server_name: 'spaces',
              original_tool_name: 'create_space',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'old-call', content: SPACE_RESULT },
      { role: 'assistant', content: 'Your space is ready.' },
      { role: 'user', content: 'What did it say again?' },
    ];
    const { thread } = makeThread({ toolSet, create, context });
    await drain(thread);

    expect(savedReply(thread)).toBe(`It said this.\n\n${TRIMMED_DUMP}`);
  });

  it('leaves a JSON object inside a code fence in the saved reply alone', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const text = `The raw result was:\n\n\`\`\`json\n${SPACE_RESULT}\n\`\`\``;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'call-1', name: 'create_space', args: { name: 'Test Kitchen Notes' } }] })
        : replyStream({ text });
    });
    const { thread } = makeThread({ toolSet, create });
    await drain(thread);

    expect(savedReply(thread)).toBe(text);
  });
});
