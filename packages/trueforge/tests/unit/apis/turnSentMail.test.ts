/**
 * A message the person sends through the Email connector is saved as one note once its result is
 * executed_ok. Covers the plain drain of a turn, and the card path, where the person approves the
 * send in a later turn that never sees the message that asked for it.
 */
import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  Sessions,
  TurnResourceResolver,
  type ITurnResourceResolver,
} from '@truefoundry/trueforge-core/agent-session';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  toolResultResponse,
  ToolSet,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
  type ToolSource,
} from '@truefoundry/trueforge-core/core';
import { getEmptyUsage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import winston from 'winston';
import { approvedToolCalls } from '../../../src/apis/approvedToolCalls';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { type RetainItem } from '../../../src/runtime/memory/memoryClient';
import { NOTE_SOURCE_METADATA_KEY } from '../../../src/runtime/memory/memoryNotes';
import { MEMORY_ORIGIN_METADATA_KEY } from '../../../src/runtime/memory/memoryOrigin';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { QuietMemoryClient } from '../../fixtures/memory/quietMemoryClient';

const NOW = '2026-10-31T12:00:00.000Z';
const SEND_ARGS = JSON.stringify({
  recipients: ['nora@example.com'],
  subject: 'Saturday',
  body: 'See you at 7.',
});
const SENT_TEXT = 'To nora@example.com, subject "Saturday": See you at 7.';
const CLEAN = 'Email sent successfully to nora@example.com. Message-Id: <abc@mail.example>';

/** A result as the sidecar's answer reaches the turn: structured content wrapped by the host's envelope. */
function resultContent(text: string): string {
  return JSON.stringify({
    schema_version: 'tool.response.v2',
    outcome: { disposition: 'executed_ok' },
    result: { result: text },
  });
}

function memoryClient() {
  const client = new QuietMemoryClient();
  const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
  return { client, retain };
}

/** Every note this test's retains saved from sent messages. */
function sentNotes(retain: jest.SpyInstance): RetainItem[] {
  return retain.mock.calls
    .flatMap(([request]: [{ items: RetainItem[] }]) => request.items)
    .filter(item => item.metadata?.[NOTE_SOURCE_METADATA_KEY] === 'sent_mail');
}

async function drain({
  client,
  stream,
  approvedCalls,
  privateChat = false,
}: {
  client: QuietMemoryClient | undefined;
  stream: AsyncIterable<TurnStreamingEvent>;
  approvedCalls?: Awaited<ReturnType<typeof approvedToolCalls>>;
  privateChat?: boolean;
}): Promise<void> {
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  await drainTurnEvents({
    trackedStream: stream,
    turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-1'),
    sessionId: 's1',
    turnId: 't1',
    executionDeadline,
    logger: winston.createLogger({ silent: true }),
    turnDrains: new TurnDrainRegistry(),
    approvedCalls,
    memory:
      client === undefined
        ? undefined
        : {
            client,
            session: { is_incognito: privateChat },
            userText: 'Tell Nora I will be there at 7.',
            attachedFiles: false,
          },
  });
}

type Disposition = 'executed_ok' | 'executed_nonzero' | 'denied' | 'policy_blocked' | 'never_ran';

function callMessage({
  name,
  args,
  threadId = 'main',
  callId = 'c1',
}: {
  name: string;
  args: string;
  threadId?: string;
  callId?: string;
}): TurnStreamingEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id: 'evt_call',
    thread_id: threadId,
    created_at: NOW,
    content: null,
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name, arguments: args },
        tool_info: { type: 'truefoundry-system', name },
      },
    ],
  };
}

function toolResponse({
  disposition,
  content,
  threadId = 'main',
  callId = 'c1',
}: {
  disposition: Disposition;
  content: string;
  threadId?: string;
  callId?: string;
}): TurnStreamingEvent {
  const base = {
    type: EventType.TOOL_RESPONSE_V2,
    id: 'evt_response',
    thread_id: threadId,
    created_at: NOW,
    tool_call_id: callId,
    content,
    admission_provenance: { source: 'internal' as const },
  };
  return disposition === 'policy_blocked' || disposition === 'never_ran'
    ? {
        ...base,
        disposition,
        remediation: { reason_code: 'x', message: 'Not run.', suggested_action: 'inspect_state' },
      }
    : { ...base, disposition };
}

function sendRound({
  name = 'Email__send_email',
  args = SEND_ARGS,
  disposition = 'executed_ok',
  text = CLEAN,
}: {
  name?: string;
  args?: string;
  disposition?: Disposition;
  text?: string;
}): TurnStreamingEvent[] {
  return [callMessage({ name, args }), toolResponse({ disposition, content: resultContent(text) })];
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* streamOf(
  earlier: TurnStreamingEvent[],
  { done = true }: { done?: boolean } = {},
): AsyncGenerator<TurnStreamingEvent> {
  yield* earlier;
  if (!done) {
    return;
  }
  yield {
    type: EventType.TURN_DONE,
    id: 'evt_done',
    created_at: NOW,
    state: {
      status: 'done',
      output: { type: 'model.message', id: 'evt_out', thread_id: 'main', created_at: NOW, content: 'Sent.' },
      required_actions: [],
      completed_at: NOW,
    },
    thread_id: null,
  };
}

describe('a sent message in the drain of a turn', () => {
  it('writes exactly one note for a send that went through, marked as tool output', async () => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({})) });
    const notes = sentNotes(retain);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain(SENT_TEXT);
    expect(notes[0]?.metadata?.[MEMORY_ORIGIN_METADATA_KEY]).toBe('tool_ingested');
  });

  it('saves the note as its own write, apart from the turn exchange', async () => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({})) });
    const writes = retain.mock.calls.map(([request]: [{ items: RetainItem[] }]) => request.items);
    expect(writes).toHaveLength(2);
    expect(
      writes.filter(items => items.some(item => item.metadata?.[NOTE_SOURCE_METADATA_KEY] === 'sent_mail')),
    ).toHaveLength(1);
  });

  it('still saves the note when the turn exchange cannot be saved', async () => {
    const { client, retain } = memoryClient();
    retain.mockImplementation(({ items }: { items: RetainItem[] }) =>
      Promise.resolve(
        items.some(item => item.metadata?.[NOTE_SOURCE_METADATA_KEY] === 'sent_mail')
          ? { ok: true }
          : { ok: false, reason: 'down' },
      ),
    );
    await drain({ client, stream: streamOf(sendRound({})) });
    expect(sentNotes(retain)).toHaveLength(1);
  });

  it('saves the note even when the turn never finishes', async () => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({}), { done: false }) });
    expect(sentNotes(retain)).toHaveLength(1);
  });

  it('keeps only the text the person added to a forward, and no subject', async () => {
    const { client, retain } = memoryClient();
    const args = JSON.stringify({
      email_id: '7',
      recipients: ['nora@example.com'],
      body: 'Look at this.',
    });
    await drain({
      client,
      stream: streamOf(
        sendRound({ name: 'Email__forward_email', args, text: 'Email forwarded successfully to nora@example.com' }),
      ),
    });
    const [note] = sentNotes(retain);
    expect(note?.content).toContain('Forwarded to nora@example.com: Look at this.');
    expect(note?.content).not.toContain('subject');
  });

  it('saves a send that only has a cc', async () => {
    const { client, retain } = memoryClient();
    await drain({
      client,
      stream: streamOf(sendRound({ args: JSON.stringify({ cc: ['sam@example.com'], subject: 'Hi', body: 'x' }) })),
    });
    expect(sentNotes(retain)[0]?.content).toContain('To cc sam@example.com, subject "Hi": x');
  });

  it('writes nothing for a draft', async () => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({ name: 'Email__save_draft' })) });
    expect(sentNotes(retain)).toHaveLength(0);
  });

  it.each<Disposition>(['executed_nonzero', 'denied', 'policy_blocked', 'never_ran'])(
    'writes nothing for a send that ended %s',
    async disposition => {
      const { client, retain } = memoryClient();
      await drain({ client, stream: streamOf(sendRound({ disposition })) });
      expect(sentNotes(retain)).toHaveLength(0);
    },
  );

  it.each([
    ['a failed delivery', 'Email delivery [failed: nora@example.com (rejected); sent-copy: skipped]'],
    [
      'an uncertain delivery',
      'Email delivery [unknown: nora@example.com; sent-copy: unknown; warning: reconciliation needed]',
    ],
    ['a forward that failed', 'Email forward [failed: nora@example.com (rejected); sent-copy: skipped]'],
  ])('writes nothing for %s that the sidecar reports as a normal result', async (_name, text) => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({ text })) });
    expect(sentNotes(retain)).toHaveLength(0);
  });

  it('saves a send that went out even though its Sent copy could not be filed', async () => {
    const { client, retain } = memoryClient();
    await drain({
      client,
      stream: streamOf(
        sendRound({
          text: 'Email delivery [succeeded: nora@example.com; message-id: <a@b.example>; sent-copy: failed (Sent); warning: reconciliation needed]',
        }),
      ),
    });
    expect(sentNotes(retain)).toHaveLength(1);
  });

  it('does not match a result to a call made on another thread', async () => {
    const { client, retain } = memoryClient();
    await drain({
      client,
      stream: streamOf([
        callMessage({ name: 'Email__send_email', args: SEND_ARGS, threadId: 'sub' }),
        toolResponse({ disposition: 'executed_ok', content: resultContent(CLEAN), threadId: 'main' }),
      ]),
    });
    expect(sentNotes(retain)).toHaveLength(0);
  });

  it('saves at most 20 sent messages from one turn', async () => {
    const { client, retain } = memoryClient();
    const rounds = Array.from({ length: 25 }, (_unused, index) => [
      callMessage({ name: 'Email__send_email', args: SEND_ARGS, callId: `c${String(index)}` }),
      toolResponse({ disposition: 'executed_ok', content: resultContent(CLEAN), callId: `c${String(index)}` }),
    ]).flat();
    await drain({ client, stream: streamOf(rounds) });
    expect(sentNotes(retain)).toHaveLength(20);
  });

  it('writes nothing to memory for a send made in a private chat', async () => {
    const { client, retain } = memoryClient();
    await drain({ client, stream: streamOf(sendRound({})), privateChat: true });
    expect(retain).not.toHaveBeenCalled();
  });

  it('does nothing when memory is off', async () => {
    await expect(drain({ client: undefined, stream: streamOf(sendRound({})) })).resolves.toBeUndefined();
  });
});

function toolCallStream(call: {
  id: string;
  name: string;
  args: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls = [{ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } }];
  return (async function* () {
    yield {
      id: 'chunk-call',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: calls.map((toolCall, index) => ({ index, ...toolCall })) },
          finish_reason: 'tool_calls',
        },
      ],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: calls },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  })();
}

function textStream(text: string): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    yield {
      id: 'chunk-text',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
  })();
}

/**
 * A real chat in which the model asks to send mail through the Email connector. The send needs a
 * card, so it pauses; the person's approval runs it in the next turn.
 */
async function chatWithSendCard({ approve, sidecarText = CLEAN }: { approve: boolean; sidecarText?: string }) {
  const sendEmail = jest.fn(() => Promise.resolve(toolResultResponse({ text: sidecarText })));
  const source: ToolSource = {
    name: 'Email',
    id: 'Email',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'Email__send_email',
              description: 'Send a message',
              inputSchema: { type: 'object' as const, properties: {} },
              preload: true,
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool: sendEmail,
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'Email',
        mcp_server_name: 'Email',
        original_tool_name: params.name,
      }),
  };
  const create = jest.fn();
  create.mockImplementationOnce(() => toolCallStream({ id: 'call-send', name: 'Email__send_email', args: SEND_ARGS }));
  create.mockImplementation(() => textStream('Done.'));
  const silent = winston.createLogger({ silent: true });
  const base = new TurnResourceResolver<TurnCustom>({
    llm: () =>
      Promise.resolve({
        modelClient: { create, createNonStream: jest.fn() },
        defaultModelParams: {},
        modelId: undefined,
        modelSupportsVision: false,
      }),
    mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: silent,
  });
  const resolver: ITurnResourceResolver<TurnCustom> = {
    get logger() {
      return base.logger;
    },
    get webSearchTurn() {
      return base.webSearchTurn;
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
  const sentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  const session = await new Sessions<SessionCustom, TurnCustom>({ sessionStore, sentinelServices }).create({
    tenant_id: 'tenant-1',
    session_id: 's1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({
        model: { name: 'test-provider/test-model' },
        instructions: 'You are a test agent.',
        config: {
          iteration_limit: 5,
          ask_user_questions: { enabled: false },
          dynamic_sub_agents: { enabled: false },
          generative_ui: { enabled: false },
          context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
        },
      }),
    },
    external_id: null,
  });
  const { client, retain } = memoryClient();

  async function run({
    turnId,
    input,
    previousTurnId,
  }: {
    turnId: string;
    input: Parameters<typeof session.createTurn>[0]['input'];
    previousTurnId: string;
  }) {
    const turn = await session.createTurn({
      turn_id: turnId,
      input,
      previous_turn_id: previousTurnId,
      signal: new AbortController().signal,
      resolver,
    });
    // What the create-turn route does before it drains an approval turn.
    const approvedCalls = await approvedToolCalls({
      pausedTurn: previousTurnId === 'none' ? undefined : await session.getTurn(previousTurnId),
      input,
      logger: silent,
    });
    await drain({ client, stream: turn.stream(), approvedCalls });
    return turn;
  }

  const first = await run({
    turnId: 'turn-1',
    input: [{ type: EventType.USER_MESSAGE, content: 'Tell Nora I will be there at 7.' }],
    previousTurnId: 'none',
  });
  const paused = await session.getTurn(first.id);
  const requiredActions = paused?.state.status === 'done' ? paused.state.required_actions : [];
  const card = requiredActions.find(action => action.type === EventType.TOOL_APPROVAL_REQUIRED);
  if (card === undefined) {
    throw new Error('expected the send to wait for the person');
  }
  const answer = await run({
    turnId: 'turn-2',
    input: [
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: card.thread_id ?? '',
        tool_call_id: 'call-send',
        approval: approve ? { status: 'allow' } : { status: 'deny', reason: 'Not now.' },
      },
    ],
    previousTurnId: first.id,
  });
  return { retain, sendEmail, answer };
}

describe('a send approved on a card', () => {
  it('is saved once, from the turn that runs it', async () => {
    const chat = await chatWithSendCard({ approve: true });
    expect(chat.sendEmail).toHaveBeenCalledTimes(1);
    const notes = sentNotes(chat.retain);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain(SENT_TEXT);
  });

  it('is not saved when the sidecar says the delivery failed', async () => {
    const chat = await chatWithSendCard({
      approve: true,
      sidecarText: 'Email delivery [failed: nora@example.com (rejected); sent-copy: skipped]',
    });
    expect(chat.sendEmail).toHaveBeenCalledTimes(1);
    expect(sentNotes(chat.retain)).toHaveLength(0);
  });

  it('is not saved when the person turns it down', async () => {
    const chat = await chatWithSendCard({ approve: false });
    expect(chat.sendEmail).not.toHaveBeenCalled();
    expect(sentNotes(chat.retain)).toHaveLength(0);
  });
});
