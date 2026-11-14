import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { EventType } from '../../../src/core/events/schema';
import type { LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger } from '../harnessMocks';

/** One reply on the given day, on top of the chat saved so far. Returns what the model was sent and the chat after. */
async function replyOn(input: { day: string; context: ContextMessage[] | undefined; message: string }) {
  jest.setSystemTime(new Date(`${input.day}T09:00:00Z`));
  const requests: LLMCreateParamsStreaming[] = [];
  const thread = new AgentThread({
    definition: {
      modelClient: {
        create: jest.fn((request: LLMCreateParamsStreaming) => {
          requests.push(request);
          return textReplyStream('Noted.');
        }),
        createNonStream: jest.fn(),
      },
      instruction: 'test',
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: 'main',
    title: 'Main',
    context: input.context,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: input.message }] });
  return { messages: requests[0]?.messages ?? [], context: thread.toSnapshot().context };
}

function texts(messages: readonly ChatCompletionMessageParam[]): string[] {
  return messages.map(message => (typeof message.content === 'string' ? message.content : ''));
}

describe('the date each message was sent', () => {
  beforeEach(() => {
    // Only the clock is faked; the reply stream still runs on real timers.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a later reply the day an earlier message was sent', async () => {
    const first = await replyOn({ day: '2026-11-03', context: undefined, message: 'I fly to Lisbon tomorrow.' });
    const later = await replyOn({ day: '2026-11-13', context: first.context, message: 'How was the weather there?' });

    const sent = texts(later.messages);
    const earlierNote = sent.findIndex(text =>
      text.includes('messages from here on were sent on 2026-11-03 (Tuesday, UTC)'),
    );
    const laterNote = sent.findIndex(text =>
      text.includes('messages from here on were sent on 2026-11-13 (Friday, UTC)'),
    );
    expect(earlierNote).toBeGreaterThan(-1);
    expect(sent[earlierNote + 1]).toBe('I fly to Lisbon tomorrow.');
    expect(laterNote).toBeGreaterThan(earlierNote);
    expect(sent[sent.length - 1]).toBe('How was the weather there?');
  });

  it('gives the date once for messages sent on the same day', async () => {
    const first = await replyOn({ day: '2026-11-03', context: undefined, message: 'I fly to Lisbon tomorrow.' });
    const sameDay = await replyOn({ day: '2026-11-03', context: first.context, message: 'Which terminal?' });

    const sent = texts(sameDay.messages);
    expect(sent.filter(text => text.includes('messages from here on were sent on'))).toHaveLength(1);
    expect(sent[sent.indexOf('I fly to Lisbon tomorrow.') - 1]).toContain('2026-11-03 (Tuesday, UTC)');
  });

  it('saves the send time on the message itself and adds no note to the saved chat', async () => {
    const first = await replyOn({ day: '2026-11-03', context: undefined, message: 'I fly to Lisbon tomorrow.' });

    expect(first.context).toEqual([
      { role: 'user', content: 'I fly to Lisbon tomorrow.', sent_at: '2026-11-03T09:00:00.000Z' },
      expect.objectContaining({ role: 'assistant' }),
    ]);
  });

  it('sends a message saved without a send time as it is', async () => {
    const later = await replyOn({
      day: '2026-11-13',
      context: [
        { role: 'user', content: 'An older message.' },
        { role: 'assistant', content: 'Noted.' },
      ],
      message: 'And now?',
    });

    const sent = texts(later.messages);
    expect(sent.filter(text => text.includes('messages from here on were sent on'))).toHaveLength(1);
    expect(sent[sent.indexOf('An older message.') - 1]).not.toContain('messages from here on were sent on');
  });

  it('keeps the earlier part of the request the same on the later reply', async () => {
    const first = await replyOn({ day: '2026-11-03', context: undefined, message: 'I fly to Lisbon tomorrow.' });
    const later = await replyOn({ day: '2026-11-13', context: first.context, message: 'How was the weather there?' });

    // The first request minus the block that is only for one reply: system prompt, date note, message.
    const savedPart = first.messages.filter(message => !texts([message])[0]?.includes('<reply-context>'));
    expect(later.messages.slice(0, savedPart.length)).toEqual(savedPart);
  });
});
