import type {
  CompletionUsage,
  ExtendedChatCompletionChunk,
  ILLM,
  LLMCreateParams,
  RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import type { ICompletedTurnEventStore } from '../../../src/db/completedTurnEvents';
import { assertPassthroughAuditEvents } from '../../../src/db/completedTurnEvents';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import {
  flushModelUsage,
  modelIdentity,
  reportedUsage,
  TurnModelUsageLedger,
  UsageRecordingLLM,
  type ModelIdentity,
} from '../../../src/runtime/modelUsage';
import type { TurnStreamingEvent } from '../../../src/schemas/events';

const SUPER: ModelIdentity = {
  model_name: 'tokenfactory/nemotron-3-super-120b-a12b',
  model_id: 'nvidia/nemotron-3-super-120b-a12b',
  provider: 'tokenfactory',
};
const NANO: ModelIdentity = {
  model_name: 'tokenfactory/nvidia-nemotron-3-nano-30b-a3b',
  model_id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  provider: 'tokenfactory',
};
const LOCAL: ModelIdentity = { model_name: 'local-vllm/local-model', model_id: 'local-model', provider: 'custom' };
const NOW = new Date('2026-10-15T12:00:00.000Z');

function usage({
  input,
  output,
  ...extra
}: { input: number; output: number } & Partial<CompletionUsage>): CompletionUsage {
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, ...extra };
}

function ledger(prices = {}) {
  return new TurnModelUsageLedger({ prices, now: () => NOW });
}

describe('reportedUsage', () => {
  it('treats absent and all-zero usage as not reported', () => {
    expect(reportedUsage(undefined)).toBeNull();
    expect(reportedUsage(null)).toBeNull();
    expect(reportedUsage(usage({ input: 0, output: 0 }))).toBeNull();
    expect(reportedUsage(usage({ input: 10, output: 0 }))).toEqual(usage({ input: 10, output: 0 }));
  });
});

describe('modelIdentity', () => {
  it('names the configured model, the id the provider is called with, and the provider type', () => {
    expect(
      modelIdentity({ name: 'a/b', providerConfig: { model: { id: 'org/m' }, provider: { type: 'custom' } } }),
    ).toEqual({ model_name: 'a/b', model_id: 'org/m', provider: 'custom' });
  });
});

describe('TurnModelUsageLedger', () => {
  it('sums the calls of one role on one model into one event with provider-reported tokens and the table price', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1000, output: 100 }) });
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 800, output: 240 }) });

    const [event, ...rest] = turn.takeEvents();

    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: 'aman.model.usage',
      role: 'chat',
      model_name: SUPER.model_name,
      model_id: SUPER.model_id,
      display_name: 'Nemotron 3 Super',
      provider: 'tokenfactory',
      calls: 2,
      reported_calls: 2,
      input_tokens: 1800,
      output_tokens: 340,
      created_at: NOW.toISOString(),
    });
    expect(event?.cost_usd).toBeCloseTo((1800 * 0.3 + 340 * 0.9) / 1_000_000, 12);
    expect(typeof event?.id).toBe('string');
  });

  it('keeps helper roles and other models apart from the answer', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1000, output: 100 }) });
    turn.record({ role: 'summarization', identity: NANO, usage: usage({ input: 500, output: 50 }) });
    turn.record({ role: 'profile_learning', identity: NANO, usage: usage({ input: 400, output: 40 }) });
    turn.record({ role: 'summarization', identity: NANO, usage: usage({ input: 100, output: 10 }) });

    const events = turn.takeEvents();

    expect(events.map(event => [event.role, event.display_name, event.calls, event.input_tokens])).toEqual([
      ['chat', 'Nemotron 3 Super', 1, 1000],
      ['summarization', 'Nemotron 3 Nano', 2, 600],
      ['profile_learning', 'Nemotron 3 Nano', 1, 400],
    ]);
  });

  it('shows a call with no reported usage as not reported, never as zero tokens at zero cost', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: null });

    expect(turn.takeEvents()).toEqual([
      expect.objectContaining({ calls: 1, reported_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: null }),
    ]);
  });

  it('counts only the calls that reported when some did not, and still prices them', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1000, output: 0 }) });
    turn.record({ role: 'chat', identity: SUPER, usage: null });

    const [event] = turn.takeEvents();

    expect(event).toMatchObject({ calls: 2, reported_calls: 1, input_tokens: 1000 });
    expect(event?.cost_usd).toBeCloseTo(0.0003, 12);
  });

  it('gives tokens only, with no cost, on a provider with no configured price', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: LOCAL, usage: usage({ input: 70, output: 30 }) });

    expect(turn.takeEvents()).toEqual([
      expect.objectContaining({ display_name: 'local-model', input_tokens: 70, output_tokens: 30, cost_usd: null }),
    ]);
  });

  it('prices a non-Token-Factory model once a price is configured for it', () => {
    const turn = ledger({ 'local-model': { input_per_million: 2, output_per_million: 4 } });
    turn.record({ role: 'chat', identity: LOCAL, usage: usage({ input: 500_000, output: 250_000 }) });

    expect(turn.takeEvents()[0]?.cost_usd).toBeCloseTo(2, 10);
  });

  it('applies a price override from configuration over the default', () => {
    const turn = ledger({ [SUPER.model_id]: { input_per_million: 10, output_per_million: 20 } });
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1_000_000, output: 1_000_000 }) });

    expect(turn.takeEvents()[0]?.cost_usd).toBeCloseTo(30, 10);
  });

  it('prefers the cost the provider reports over the table', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1000, output: 100, cost_in_usd: 0.5 }) });

    expect(turn.takeEvents()[0]?.cost_usd).toBe(0.5);
  });

  it('leaves the cost unknown when one reported call cannot be priced, rather than understating it', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: LOCAL, usage: usage({ input: 10, output: 10, cost_in_usd: 0.01 }) });
    turn.record({ role: 'chat', identity: LOCAL, usage: usage({ input: 10, output: 10 }) });

    expect(turn.takeEvents()[0]?.cost_usd).toBeNull();
  });

  it('hands each call out once, so a later take returns only calls recorded since', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 1, output: 1 }) });
    expect(turn.takeEvents()).toHaveLength(1);
    expect(turn.takeEvents()).toEqual([]);

    turn.record({ role: 'summarization', identity: NANO, usage: usage({ input: 2, output: 2 }) });
    expect(turn.takeEvents().map(event => event.role)).toEqual(['summarization']);
  });

  it('produces events the durable log accepts', () => {
    const turn = ledger();
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 10, output: 5 }) });
    turn.record({ role: 'chat', identity: LOCAL, usage: null });

    expect(() => assertPassthroughAuditEvents(turn.takeEvents())).not.toThrow();
  });
});

function scripted(options: {
  chunks: ExtendedChatCompletionChunk[];
  final: RawAssistantMessageWithUsage;
  failure?: Error;
}): ILLM {
  async function* create(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    for (const chunk of options.chunks) {
      yield chunk;
    }
    if (options.failure !== undefined) {
      throw options.failure;
    }
    return options.final;
  }
  return { create, createNonStream: (_body: LLMCreateParams) => Promise.resolve(options.final) };
}

function chunk(chunkUsage?: CompletionUsage): ExtendedChatCompletionChunk {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
    ...(chunkUsage === undefined ? {} : { usage: chunkUsage }),
  };
}

const final = (finalUsage: CompletionUsage): RawAssistantMessageWithUsage => ({
  output: { role: 'assistant', content: 'ok' },
  usage: finalUsage,
  finish_reason: 'stop',
});

async function drain(llm: ILLM): Promise<void> {
  const stream = llm.create({ messages: [{ role: 'user', content: 'hi' }], stream: true });
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }
}

describe('UsageRecordingLLM', () => {
  it('reports the usage of a finished stream once', async () => {
    const onCall = jest.fn();
    const llm = new UsageRecordingLLM({
      llm: scripted({
        chunks: [chunk(), chunk(usage({ input: 30, output: 4 }))],
        final: final(usage({ input: 30, output: 4 })),
      }),
      onCall,
    });

    await drain(llm);

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall).toHaveBeenCalledWith(usage({ input: 30, output: 4 }));
  });

  it('reports a finished call whose provider sent no usage as not reported', async () => {
    const onCall = jest.fn();
    const llm = new UsageRecordingLLM({
      llm: scripted({ chunks: [chunk()], final: final(usage({ input: 0, output: 0 })) }),
      onCall,
    });

    await drain(llm);

    expect(onCall).toHaveBeenCalledWith(null);
  });

  it('keeps the usage a stream reported before it failed, and skips a failure that reported none', async () => {
    const reported = jest.fn();
    await expect(
      drain(
        new UsageRecordingLLM({
          llm: scripted({
            chunks: [chunk(usage({ input: 9, output: 1 }))],
            final: final(usage({ input: 0, output: 0 })),
            failure: new Error('cut'),
          }),
          onCall: reported,
        }),
      ),
    ).rejects.toThrow('cut');
    expect(reported).toHaveBeenCalledWith(usage({ input: 9, output: 1 }));

    const silent = jest.fn();
    await expect(
      drain(
        new UsageRecordingLLM({
          llm: scripted({
            chunks: [chunk()],
            final: final(usage({ input: 0, output: 0 })),
            failure: new Error('refused'),
          }),
          onCall: silent,
        }),
      ),
    ).rejects.toThrow('refused');
    expect(silent).not.toHaveBeenCalled();
  });

  it('reports a non-streaming call from its returned usage', async () => {
    const onCall = jest.fn();
    const llm = new UsageRecordingLLM({
      llm: scripted({ chunks: [], final: final(usage({ input: 12, output: 8 })) }),
      onCall,
    });

    await llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });

    expect(onCall).toHaveBeenCalledWith(usage({ input: 12, output: 8 }));
  });
});

describe('flushModelUsage', () => {
  const logger = createLogger({ silent: true });

  function setup(append: ICompletedTurnEventStore['appendEventsToDoneTurn']) {
    const turn = ledger();
    const eventStore: ICompletedTurnEventStore = { appendEventsToDoneTurn: jest.fn(append) };
    const turnEventStream = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-1');
    const put = jest.spyOn(turnEventStream, 'put');
    return { turn, eventStore, turnEventStream, put, member: { ledger: turn, eventStore } };
  }

  it('persists the new events to the done turn and echoes them to the live stream, once', async () => {
    const { turn, eventStore, turnEventStream, put, member } = setup(() => Promise.resolve());
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 10, output: 5 }) });

    await flushModelUsage({ member, sessionId: 's1', turnId: 't1', turnEventStream, logger });
    await flushModelUsage({ member, sessionId: 's1', turnId: 't1', turnEventStream, logger });

    expect(eventStore.appendEventsToDoneTurn).toHaveBeenCalledTimes(1);
    expect(eventStore.appendEventsToDoneTurn).toHaveBeenCalledWith({
      session_id: 's1',
      turn_id: 't1',
      events: [expect.objectContaining({ type: 'aman.model.usage', role: 'chat' })],
    });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('never throws when the store refuses, and does not stream what it could not persist', async () => {
    const { turn, turnEventStream, put, member } = setup(() => Promise.reject(new Error('not done')));
    turn.record({ role: 'chat', identity: SUPER, usage: usage({ input: 10, output: 5 }) });

    await expect(
      flushModelUsage({ member, sessionId: 's1', turnId: 't1', turnEventStream, logger }),
    ).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});
