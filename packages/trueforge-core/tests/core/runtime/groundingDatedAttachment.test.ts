import type { DocumentIngestionEvent } from '../../../src/core/events/schema';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadAppendContext } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import type { AgentInputUserMessage } from '../../../src/core/runtime/UserInputMessage';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { syntheticBytesFor } from '../documents/syntheticFiles';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, makeStubPublicSandbox, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const SHEET_TEXT = 'Inventory count sheet\nCount date: 14 March 2028\nWidget A: 40 units\nWidget B: 15 units';

function dataUri(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
}

function makeSearchToolSet() {
  const toolSet = makeMockIMCPServer({
    name: 'web',
    preload: true,
    tools: [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { ...OBJECT_INPUT_SCHEMA, properties: { query: { type: 'string' } }, required: ['query'] },
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: toolSet.id,
    mcp_server_name: toolSet.name,
    original_tool_name: 'web_search',
    is_approval_required: false,
  });
  jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'search results' }));
  return toolSet;
}

function makeSandboxWithSheet() {
  const sandbox = makeStubPublicSandbox();
  jest
    .spyOn(sandbox, 'uploadUserFile')
    .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
  jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input =>
    Promise.resolve({
      filePath: input.filePath,
      content: syntheticBytesFor(input.filePath),
      verify: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    }),
  );
  jest
    .spyOn(sandbox, 'runDocumentText')
    .mockResolvedValue({ total_pages: 1, pages: [{ page_number: 1, text: SHEET_TEXT }] });
  return sandbox;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function runWithSheet(input: { personText: string; replies: string[] }) {
  const sandbox = makeSandboxWithSheet();
  const toolSet = makeSearchToolSet();
  let calls = 0;
  const create = jest.fn(() => {
    const reply = input.replies[Math.min(calls, input.replies.length - 1)] ?? '';
    calls += 1;
    return finalStream(reply);
  });
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
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    },
    context: [],
    sandbox,
  });
  const signal = new AbortController().signal;
  const message: AgentInputUserMessage = {
    type: EventType.USER_MESSAGE,
    content: [
      { type: 'text', text: input.personText },
      { type: 'file', name: 'inventory.pdf', data: dataUri('application/pdf', 'a') },
    ],
  };
  for await (const _event of thread.send([message], signal)) {
    // draining the append is enough
  }

  const ingestion: DocumentIngestionEvent[] = [];
  const appends: AgentThreadAppendContext[] = [];
  const finals: string[] = [];
  const deltas: string[] = [];
  for await (const event of thread.execute({ signal })) {
    if (event.type === EventType.DOCUMENT_INGESTION) {
      ingestion.push(event);
    }
    if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
      appends.push(event);
      for (const output of event.output) {
        if (output.type === EventType.MODEL_MESSAGE && typeof output.content === 'string') {
          finals.push(output.content);
        }
      }
    }
    if (event.type === EventType.MODEL_MESSAGE_DELTA && typeof event.content === 'string') {
      deltas.push(event.content);
    }
  }
  return { create, ingestion, appends, finals, deltas, thread };
}

describe('grounding with a dated attachment', () => {
  it('answers once when the person only reports sending a sheet dated 2028', async () => {
    const { create, ingestion, appends, finals } = await runWithSheet({
      personText: 'I sent the sheet.',
      replies: ['First reply.', 'Second reply.'],
    });

    expect(ingestion.map(event => event.phase)).toEqual(['started', 'finished']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(appends.filter(event => event.grounding_nudge === true)).toHaveLength(0);
    expect(finals).toEqual(['First reply.']);
  });

  it('still grounds a genuine freshness question about the attached sheet', async () => {
    const { create, ingestion, appends, finals, deltas } = await runWithSheet({
      personText: 'Is the 2028 edition of this sheet out yet?',
      replies: ['Draft from memory.', 'Checked answer.'],
    });

    expect(ingestion.map(event => event.phase)).toEqual(['started', 'finished']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(appends.filter(event => event.grounding_nudge === true)).toHaveLength(1);
    expect(finals).toEqual(['Checked answer.']);
    expect(deltas.join('')).not.toContain('Draft from memory.');
  });
});
