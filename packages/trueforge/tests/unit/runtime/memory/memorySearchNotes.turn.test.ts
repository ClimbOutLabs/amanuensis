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
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { z } from 'zod';

import { MemoryTurnResourceResolver } from '../../../../src/runtime/MemoryTurnResourceResolver';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { namespaceDirFor, sanitizeNamespace } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';

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
    for await (const _event of orchestrator.send([{ type: EventType.USER_MESSAGE, content: 'Any news on my delivery?' }])) {
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
});
