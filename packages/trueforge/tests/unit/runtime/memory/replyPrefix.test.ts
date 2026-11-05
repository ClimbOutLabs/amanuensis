import type { ContextMessage } from '@truefoundry/trueforge-core/core';
import {
  AgentThread,
  toolResultResponse,
  ToolSet,
  type ExtendedChatCompletionChunk,
  type ILLM,
  type IToolSet,
  type LLMCreateParamsStreaming,
  type RawAssistantMessageWithUsage,
  type ToolSource,
} from '@truefoundry/trueforge-core/core';
import { getEmptyUsage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import winston from 'winston';
import { hindsightMemoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';

const NOTE_TOOL = 'write_note';

const DEFAULT_RECALL = ["Alex's wife is named Robin.", 'Coffee with Robin on Friday.'];

const CONFIG: MemoryConfig = {
  recallMaxTokens: 600,
  recallEntityTokens: 0,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: false, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

function makeLogger() {
  return winston.createLogger({ silent: true });
}

function makeMemoryClient(recalledText: string[]): MemoryClient {
  return {
    recall: jest.fn().mockResolvedValue({
      ok: true,
      results: recalledText.map((text, index) => ({
        id: String(index),

        occurred_start: '2026-08-14T00:00:00Z',
        text,
      })),
      entities: [],
      budgetTokens: 600,
    }),
    retain: jest.fn().mockResolvedValue({ ok: true }),
    getOperation: jest.fn().mockResolvedValue({ ok: true, status: 'unknown' }),
    retryOperation: jest.fn().mockResolvedValue({ ok: true }),
    getProfile: jest
      .fn()
      .mockResolvedValue({ ok: true, profile: { name: undefined, mission: undefined, background: undefined } }),
    listMentalModels: jest.fn().mockResolvedValue({ ok: true, models: [] }),
    reflect: jest.fn().mockResolvedValue({ ok: true, text: '', basedOn: 0 }),
    listEntries: jest.fn().mockResolvedValue({ ok: true, entries: [] }),
    updateEntry: jest.fn(),
    deleteEntry: jest.fn(),
    deleteDocument: jest.fn(),
  };
}

function noteToolSet(): IToolSet {
  const source: ToolSource = {
    name: 'notes',
    id: 'notes',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: NOTE_TOOL,
              description: 'Write a note',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              preload: true,
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool: () => Promise.resolve(toolResultResponse({ text: 'note written' })),
    toolCallInfo: () =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'notes',
        mcp_server_name: 'notes',
        original_tool_name: NOTE_TOOL,
      }),
  };
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    preload: true,
  });
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCall = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: NOTE_TOOL, arguments: JSON.stringify({ text: 'hello' }) },
  };
  yield {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [toolCall] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalTextStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'c2',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Saved.' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'Saved.' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

const DEFAULT_HISTORY: ContextMessage[] = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
];

/** Runs one reply (tool call, then final text) and returns the request body sent at each model step. */
async function runReply(
  userText: string,
  recalledText: string[] = DEFAULT_RECALL,
  history: ContextMessage[] = DEFAULT_HISTORY,
): Promise<LLMCreateParamsStreaming[]> {
  let stepCount = 0;
  const create = jest.fn((_request: LLMCreateParamsStreaming) => {
    stepCount += 1;
    return stepCount === 1 ? toolCallStream() : finalTextStream();
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const memory = hindsightMemoryCapability({
    client: makeMemoryClient(recalledText),
    config: CONFIG,
    logger: makeLogger(),
    sessionId: 'session-1',
    previousTurnId: null,
  });
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    turnToolCallLedger: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeLogger(),
    definition: {
      modelClient,
      modelId: 'test-model',
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      identity: { assistantName: 'Aman', personName: 'Alex' },
    },
    capabilities: [{ systemToolSets: [noteToolSet()] }, memory],
    context: [...history, { role: 'user', content: userText }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
  }
  return create.mock.calls.map(call => call[0]);
}

const CAPTURE_DIR = process.env['REPLY_PREFIX_CAPTURE_DIR'];

/** The last message of the shared earlier history in every fixture; the prefix that is reusable across replies. */
const HISTORY_END = 'earlier answer';

/** Everything the provider can cache within a reply: all messages before the current message. */
function prefixBeforeCurrent(request: LLMCreateParamsStreaming, userText: string): ChatCompletionMessageParam[] {
  const index = request.messages.findIndex(message => message.content === userText);
  expect(index).toBeGreaterThan(0);
  return request.messages.slice(0, index);
}

/** Everything through the end of the earlier history, which a later reply shares with this one. */
function prefixThroughHistory(request: LLMCreateParamsStreaming): string {
  const index = request.messages.findIndex(message => message.content === HISTORY_END);
  expect(index).toBeGreaterThan(0);
  return JSON.stringify(request.messages.slice(0, index + 1));
}

describe('reply prefix stability', () => {
  beforeEach(() => {
    // Only Date is faked: a pinned clock keeps the per-reply date the same across the replies compared here.
    jest.useFakeTimers({
      now: new Date('2026-10-22T12:00:00Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('step 2 sends the same bytes before the current message, and the same tools, as step 1', async () => {
    const [step1, step2] = await runReply('Remember that Robin likes tea.');
    if (CAPTURE_DIR !== undefined) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      writeFileSync(join(CAPTURE_DIR, 'step1.json'), JSON.stringify(step1, null, 2));
      writeFileSync(join(CAPTURE_DIR, 'step2.json'), JSON.stringify(step2, null, 2));
      const [reply2Step1] = await runReply('Where does Robin live now?', ['Robin moved to Lisbon in May.']);
      writeFileSync(join(CAPTURE_DIR, 'reply2-step1.json'), JSON.stringify(reply2Step1, null, 2));
    }
    expect(step1).toBeDefined();
    expect(step2).toBeDefined();
    if (!step1 || !step2) {
      throw new Error('expected two model steps');
    }
    // The prefix is the static instruction, the earlier history, then the per-reply block and the
    // recalled memory block, both just before the current message.
    const prefix = prefixBeforeCurrent(step1, 'Remember that Robin likes tea.');
    expect(prefix).toHaveLength(5);
    expect(prefix[3]).toMatchObject({ role: 'system', content: expect.stringContaining("Today's date") });
    expect(prefix[4]).toMatchObject({ role: 'system', content: expect.stringContaining('<aman-memory>') });
    expect(JSON.stringify(prefixBeforeCurrent(step2, 'Remember that Robin likes tea.'))).toBe(JSON.stringify(prefix));
    expect(JSON.stringify(step2.tools)).toBe(JSON.stringify(step1.tools));
    expect(String(step1.messages[0]?.content)).not.toMatch(/Today's date|Alex/);
  });

  it('two replies share the same static prefix and tools', async () => {
    const [firstReply] = await runReply('Remember that Robin likes tea.');
    if (!firstReply) {
      throw new Error('expected a model step in the first reply');
    }
    // The second reply's history includes the first reply's exchange, as a real conversation does.
    // Every tool goes out on every request, so nothing the message says changes the prefix.
    const [secondReply] = await runReply('Remember that Robin likes tea too.', DEFAULT_RECALL, [
      ...DEFAULT_HISTORY,
      { role: 'user', content: 'Remember that Robin likes tea.' },
      { role: 'assistant', content: 'Saved.' },
    ]);
    if (!secondReply) {
      throw new Error('expected a model step in the second reply');
    }
    expect(JSON.stringify(secondReply.messages[0])).toBe(JSON.stringify(firstReply.messages[0]));
    expect(JSON.stringify(secondReply.tools)).toBe(JSON.stringify(firstReply.tools));
    expect(prefixThroughHistory(secondReply)).toBe(prefixThroughHistory(firstReply));
  });

  it('a web question keeps the static prefix and the tools, with guidance left for the model to read', async () => {
    const [firstReply] = await runReply('Remember that Robin likes tea.');
    const [secondReply] = await runReply('Where does Robin live now?', ['Robin moved to Lisbon in May.']);
    if (!firstReply || !secondReply) {
      throw new Error('expected a model step in both replies');
    }
    expect(JSON.stringify(secondReply.messages[0])).toBe(JSON.stringify(firstReply.messages[0]));
    expect(JSON.stringify(secondReply.tools)).toBe(JSON.stringify(firstReply.tools));
    expect(String(secondReply.messages[0]?.content)).toContain('- web: finding and citing sources');
    const replyBlock = secondReply.messages.find(
      message => message.role === 'system' && String(message.content).includes('<reply-context>'),
    );
    expect(replyBlock).toBeDefined();
    expect(String(replyBlock?.content)).not.toContain('<source-discovery>');
  });
});
