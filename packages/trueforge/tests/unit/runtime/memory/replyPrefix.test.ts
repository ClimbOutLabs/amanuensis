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
        type: 'world',
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

/** Runs one reply (tool call, then final text) and returns the request body sent at each model step. */
async function runReply(
  userText: string,
  recalledText: string[] = DEFAULT_RECALL,
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
    context: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: userText },
    ],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
  }
  return create.mock.calls.map(call => call[0]);
}

const CAPTURE_DIR = process.env['REPLY_PREFIX_CAPTURE_DIR'];

/** The first history message in every fixture reply; everything before it is the prefix the provider can cache. */
const HISTORY_START = 'earlier question';

function prefixBeforeHistory(request: LLMCreateParamsStreaming): string {
  const index = request.messages.findIndex(message => message.content === HISTORY_START);
  expect(index).toBeGreaterThan(0);
  return JSON.stringify(request.messages.slice(0, index));
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

  it('step 2 sends the same bytes before the history, and the same tools, as step 1', async () => {
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
    // The prefix is the static instruction, the per-reply block and the recalled memory block.
    expect(JSON.parse(prefixBeforeHistory(step1))).toHaveLength(3);
    expect(prefixBeforeHistory(step2)).toBe(prefixBeforeHistory(step1));
    expect(JSON.stringify(step2.tools)).toBe(JSON.stringify(step1.tools));
    expect(String(step1.messages[0]?.content)).not.toMatch(/Today's date|Alex/);
  });

  it('two replies on the same day with the same tools share the same static prefix', async () => {
    const [firstReply] = await runReply('Remember that Robin likes tea.');
    const [secondReply] = await runReply('What did I ask you to remember?');
    if (!firstReply || !secondReply) {
      throw new Error('expected a model step in each reply');
    }
    expect(JSON.stringify(secondReply.messages[0])).toBe(JSON.stringify(firstReply.messages[0]));
    expect(JSON.stringify(secondReply.tools)).toBe(JSON.stringify(firstReply.tools));
    expect(prefixBeforeHistory(secondReply)).toBe(prefixBeforeHistory(firstReply));
  });
});
