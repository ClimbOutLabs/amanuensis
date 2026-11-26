/**
 * The acceptance journey for mid-turn note search. In one chat a note is retained through the real
 * retain path and left unsorted (no page is made from it, so it exists only in the daily log). In a
 * second chat the person's message shares no words with the note, so the turn's opening recall cannot
 * surface it. A tool result then names the shipment for the first time in the turn, the model searches
 * the daily notes with that name, and the dated excerpt reaches it before it answers.
 *
 * The turn is wired through the real resolver, so the tools on offer are the ones production offers.
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import {
  AgentThread,
  AgentThreadOrchestrator,
  createSentinelHostContext,
  defaultSentinelServices,
  defineTool,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import type { ILLM } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { z } from 'zod';

import { MemoryTurnResourceResolver } from '../../../../src/runtime/MemoryTurnResourceResolver';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { namespaceDirFor, sanitizeNamespace } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { ScreenClient } from '../../../../src/runtime/memory/screenClient';

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

const NOTE = 'Shipment Juniper-47 needs the short mounting bracket.';
/** Two days before today, so the note sits inside the search window whenever the test runs. */
const NOTE_DAY = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The same config with the recall screen switched on, for the screening journey below. */
const SCREENED_CONFIG: MemoryConfig = {
  ...MEMORY_CONFIG,
  screen: {
    enabled: true,
    url: 'https://screen.example',
    authToken: '',
    threshold: 0.5,
    timeoutMs: 1500,
    maxConcurrency: 8,
  },
};

/** A note a tool brought in rather than the person stating it, carrying the words the test screen flags. */
const WITHHELD_NOTE = 'The Kestrel-9 ledger password is written on the office whiteboard.';

type Call = { name: string; args: Record<string, unknown> };

/** A tool standing in for a shipment tracker: its answer names Juniper-47 for the first time in the turn. */
class ShipmentReader extends LocalToolMCP {
  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  readonly name = 'Shipments';
  readonly displayName = 'Shipments';
  protected getTools(): ToolDefinition[] {
    return [
      defineTool({
        name: 'shipments__check_status',
        requiresNetwork: false,
        description: 'Check a shipment.',
        schema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        handler: () => Promise.resolve(toolResultResponse({ text: 'Juniper-47: still in transit.' })),
      }),
    ];
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* stream(
  output: RawAssistantMessageWithUsage['output'],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const finish = output.tool_calls === undefined ? 'stop' : 'tool_calls';
  yield {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          ...(typeof output.content === 'string' ? { content: output.content } : {}),
          ...(output.tool_calls === undefined
            ? {}
            : { tool_calls: output.tool_calls.map((call, index) => ({ index, ...call })) }),
        },
        finish_reason: finish,
      },
    ],
  };
  return { output, usage: getEmptyUsage(), finish_reason: finish };
}

/**
 * Runs one scripted chat through the real resolver and returns every request the model was
 * sent, in order. The scripted model works through `steps` as tool calls, then answers.
 */
async function runScriptedTurn(input: {
  client: MarkdownMemoryClient;
  config: MemoryConfig;
  screenClient?: ScreenClient | undefined;
  logger: ReturnType<typeof winston.createLogger>;
  steps: Call[];
  answer: string;
}): Promise<unknown[]> {
  const { client, config, screenClient, logger, steps, answer } = input;
  const resolver = new MemoryTurnResourceResolver(
    {
      llm: () =>
        Promise.resolve({
          modelClient: {
            create: () => {
              throw new Error('unused');
            },
            createNonStream: () => Promise.reject(new Error('unused')),
          },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: 'http://127.0.0.1:1/unused', headers: {} }),
      mcpRequestTimeoutMs: 1000,
      mcpConnectTimeoutMs: 1000,
      logger,
    },
    undefined,
    undefined,
    {
      client,
      config,
      sessionId: 'chat-b',
      previousTurnId: null,
      summarize: undefined,
      keepsNothing: false,
      ...(screenClient !== undefined ? { screenClient } : {}),
    },
    { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 },
  );
  const resolved = await resolver.resolveAgentDefinition({
    spec: AgentSpecSchema.parse({ model: { name: 'scripted/chat-model' }, instructions: 'Answer.' }),
    tenant_id: 't1',
    created_by: 'u1',
    session_id: 'chat-b',
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
  });

  const requests: unknown[] = [];
  const create: ILLM['create'] = request => {
    requests.push(request.messages);
    const done = request.messages.filter(message => message.role === 'assistant').length;
    const step = steps[done];
    if (step === undefined) {
      return stream({ role: 'assistant', content: answer });
    }
    return stream({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call-${String(done)}`,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ],
    });
  };

  const thread = new AgentThread({
    definition: {
      modelClient: { create: jest.fn(create), createNonStream: jest.fn() },
      instruction: 'You are Aman.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: [],
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: 'main',
    title: 'chat',
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: resolved.extraCapabilities ?? [],
    capabilityState: undefined,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    sentinel: createSentinelHostContext({
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'chat-b',
    }),
    tracing: NOOP_AGENT_TRACING,
    logger,
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
    tracing: NOOP_AGENT_TRACING,
    logger,
  });
  for await (const _event of orchestrator.send([
    { type: EventType.USER_MESSAGE, content: 'Any news on my delivery?' },
  ])) {
    void _event;
  }
  const iterator = orchestrator.execute({ signal: new AbortController().signal });
  let step = await iterator.next();
  while (step.done !== true) {
    step = await iterator.next();
  }
  return requests;
}

describe('searching the daily notes in the middle of a turn', () => {
  let baseDir = '';

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'note-search-turn-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('finds a note another chat retained, once a tool result names its subject', async () => {
    const logger = winston.createLogger({ silent: true });
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });

    // Chat A: the note is retained through the real retain path. Nothing sorts it onto a page.
    const retained = await client.retain({
      items: [
        {
          content: NOTE,
          timestamp: `${NOTE_DAY}T09:15:00.000Z`,
          document_id: 'chat-a',
          metadata: { origin: 'user_stated', session_id: 'chat-a' },
        },
      ],
      operationId: 'op-chat-a-1',
      timeoutMs: 5000,
    });
    expect(retained.ok).toBe(true);
    const vaultDir = namespaceDirFor(baseDir, sanitizeNamespace('tenant-1'));
    const logBefore = await readFile(path.join(vaultDir, 'memory', `${NOTE_DAY}.md`), 'utf8');
    expect(logBefore).toContain(NOTE);
    // The note exists only in the daily log: no page was made from it.
    await expect(readdir(path.join(vaultDir, 'people'))).rejects.toThrow();
    await expect(readdir(path.join(vaultDir, 'matters'))).rejects.toThrow();

    // Chat B: wired by the real resolver, with this chat's own session id.
    const resolver = new MemoryTurnResourceResolver(
      {
        llm: () =>
          Promise.resolve({
            modelClient: {
              create: () => {
                throw new Error('unused');
              },
              createNonStream: () => Promise.reject(new Error('unused')),
            },
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () => Promise.resolve({ url: 'http://127.0.0.1:1/unused', headers: {} }),
        mcpRequestTimeoutMs: 1000,
        mcpConnectTimeoutMs: 1000,
        logger,
      },
      undefined,
      undefined,
      {
        client,
        config: MEMORY_CONFIG,
        sessionId: 'chat-b',
        previousTurnId: null,
        summarize: undefined,
        keepsNothing: false,
      },
      { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 },
    );
    const resolved = await resolver.resolveAgentDefinition({
      spec: AgentSpecSchema.parse({ model: { name: 'scripted/chat-model' }, instructions: 'Answer.' }),
      tenant_id: 't1',
      created_by: 'u1',
      session_id: 'chat-b',
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
    });

    // The scripted model: check the shipment, then search the notes with the name the answer gave,
    // then answer with the note's detail. Every request it makes is recorded.
    const requests: unknown[] = [];
    const steps: Call[] = [
      { name: 'shipments__check_status', args: {} },
      { name: 'search_memory_notes', args: { query: 'Juniper-47' } },
    ];
    const create: ILLM['create'] = request => {
      requests.push(request.messages);
      const done = request.messages.filter(message => message.role === 'assistant').length;
      const step = steps[done];
      if (step === undefined) {
        return stream({
          role: 'assistant',
          content: 'Juniper-47 is still in transit. Your note says it needs the short mounting bracket.',
        });
      }
      return stream({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call-${String(done)}`,
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          },
        ],
      });
    };

    const thread = new AgentThread({
      definition: {
        modelClient: { create: jest.fn(create), createNonStream: jest.fn() },
        instruction: 'You are Aman.',
        messages: undefined,
        modelParams: undefined,
        responseFormat: undefined,
        iterationLimit: undefined,
        toolSets: [new ShipmentReader()],
        modelId: undefined,
        configuredModels: undefined,
      },
      threadId: 'main',
      title: 'chat',
      parent: undefined,
      agentInfo: undefined,
      context: undefined,
      currentContextUsage: undefined,
      preComputedCompletion: undefined,
      sandbox: undefined,
      capabilities: resolved.extraCapabilities ?? [],
      capabilityState: undefined,
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      sentinel: createSentinelHostContext({
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'chat-b',
      }),
      tracing: NOOP_AGENT_TRACING,
      logger,
    });
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[thread.threadId, thread]]),
      createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
      tracing: NOOP_AGENT_TRACING,
      logger,
    });
    for await (const _event of orchestrator.send([
      { type: EventType.USER_MESSAGE, content: 'Any news on my delivery?' },
    ])) {
      void _event;
    }
    const iterator = orchestrator.execute({ signal: new AbortController().signal });
    let step = await iterator.next();
    while (step.done !== true) {
      step = await iterator.next();
    }

    expect(requests.length).toBeGreaterThanOrEqual(3);
    // The opening recall could not surface the note: nothing in the first request names it.
    expect(JSON.stringify(requests[0])).not.toContain('Juniper');
    expect(JSON.stringify(requests[0])).not.toContain('mounting bracket');
    // The search tool's own answer, as the model received it before answering, holds the dated excerpt.
    const beforeAnswer = JSON.stringify(requests[2]);
    expect(beforeAnswer).toContain('short mounting bracket');
    expect(beforeAnswer).toContain(NOTE_DAY);
    expect(beforeAnswer).toContain(`md:tenant-1:${NOTE_DAY}.md#0`);
    // The original note is untouched and still the only copy.
    const logAfter = await readFile(path.join(vaultDir, 'memory', `${NOTE_DAY}.md`), 'utf8');
    expect(logAfter).toBe(logBefore);
  });

  it('keeps a note the screen withholds out of every model request, while an allowed note still arrives', async () => {
    const logger = winston.createLogger({ silent: true });
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });

    // Chat A retains two notes on the same day: one a tool brought in, carrying the words the
    // screen flags, and one in the person's own words on an unrelated subject.
    const retained = await client.retain({
      items: [
        {
          content: WITHHELD_NOTE,
          timestamp: `${NOTE_DAY}T09:15:00.000Z`,
          document_id: 'chat-a',
          metadata: { origin: 'tool_ingested', session_id: 'chat-a' },
        },
        {
          content: NOTE,
          timestamp: `${NOTE_DAY}T09:20:00.000Z`,
          document_id: 'chat-a',
          metadata: { origin: 'user_stated', session_id: 'chat-a' },
        },
      ],
      operationId: 'op-chat-a-screen',
      timeoutMs: 5000,
    });
    expect(retained.ok).toBe(true);

    // A deterministic screen: it flags any text naming Kestrel-9 and passes everything else.
    const screenFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>((_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const verdict = body.includes('Kestrel-9')
        ? { label: 'malicious', score: 0.99, flagged: true }
        : { label: 'benign', score: 0.01, flagged: false };
      return Promise.resolve(
        new Response(JSON.stringify(verdict), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const screenClient = new ScreenClient({
      url: 'https://screen.example',
      authToken: '',
      threshold: 0.5,
      fetchImpl: screenFetch,
    });

    // Chat B: the model searches first for the flagged subject, then for the allowed one.
    const requests = await runScriptedTurn({
      client,
      config: SCREENED_CONFIG,
      screenClient,
      logger,
      steps: [
        { name: 'search_memory_notes', args: { query: 'Kestrel-9' } },
        { name: 'search_memory_notes', args: { query: 'Juniper-47' } },
      ],
      answer: 'One matching note was withheld by the safety screen. Your bracket note is here.',
    });

    expect(requests.length).toBeGreaterThanOrEqual(3);
    // The withheld note's words never entered any request the model was sent, the opening
    // recall included: only its subject, which the model itself typed, may appear.
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain('ledger password');
      expect(JSON.stringify(request)).not.toContain('whiteboard');
    }
    // The first search's answer told the model, in plain words, that its match was withheld.
    expect(JSON.stringify(requests[1])).toContain('safety screen withheld');
    // The positive control: the allowed note reached the model through the same tool.
    expect(JSON.stringify(requests[2])).toContain('short mounting bracket');
  });
});
