import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  ContextMessage,
} from '@truefoundry/trueforge-core/core';
import { InternalEventType } from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import type { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';
import {
  classifyPreRecallGate,
  hindsightMemoryCapability,
  type MemoryConfig,
} from '../../../../src/runtime/memory/memoryCapability';

const CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: true, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};

function makeLogger() {
  return winston.createLogger({ silent: true });
}

function makeClient(overrides: {
  recall?: jest.Mock;
  getProfile?: jest.Mock;
  listMentalModels?: jest.Mock;
  getOperation?: jest.Mock;
}): HindsightClient {
  return {
    recall: overrides.recall ?? jest.fn().mockResolvedValue({ ok: true, results: [], entities: [] }),
    retain: jest.fn().mockResolvedValue({ ok: true }),
    getOperation: overrides.getOperation ?? jest.fn().mockResolvedValue({ ok: true, status: 'succeeded' }),
    retryOperation: jest.fn().mockResolvedValue({ ok: true }),
    getProfile:
      overrides.getProfile ??
      jest
        .fn()
        .mockResolvedValue({ ok: true, profile: { name: undefined, mission: undefined, background: undefined } }),
    listMentalModels: overrides.listMentalModels ?? jest.fn().mockResolvedValue({ ok: true, models: [] }),
    reflect: jest.fn().mockResolvedValue({ ok: true, text: '', basedOn: 0 }),
  } as unknown as HindsightClient;
}

function makeExecution(context: ContextMessage[]): Readonly<AgentThreadExecutionContext> {
  return {
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
}

async function collect(gen: AsyncIterable<AgentContextProcessorOutput>): Promise<AgentContextProcessorOutput[]> {
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function passthroughEvent(events: AgentContextProcessorOutput[]) {
  const found = events.find(event => event.type === InternalEventType.PASSTHROUGH);
  if (found === undefined || found.type !== InternalEventType.PASSTHROUGH) {
    throw new Error('expected a passthrough event');
  }
  if (found.event.type !== 'aman.memory.recall') {
    throw new Error('expected an aman.memory.recall event');
  }
  return found.event;
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: text };
}

describe('classifyPreRecallGate', () => {
  it.each(['hey', 'hi', 'hello!', 'yo.', 'good morning', 'GOOD EVENING!'])('skips the greeting %j', text => {
    expect(classifyPreRecallGate([userMessage(text)])).toBe('trivial_greeting');
  });

  it.each(['thanks', 'thank you!', 'thx', 'ok', 'okay.', 'got it', 'understood', 'cool', 'nice!'])(
    'skips the acknowledgement %j',
    text => {
      expect(classifyPreRecallGate([userMessage(text)])).toBe('trivial_acknowledgement');
    },
  );

  it.each([
    'remember what you told me about Madrid',
    'last time you said the flight was Tuesday',
    'you said the dog needs the elevator',
    'what did we discuss yesterday?',
    'remind me of the hotel name',
    'hey, remember the plan?',
  ])('recalls on the history reference %j', text => {
    expect(classifyPreRecallGate([userMessage(text)])).toBeUndefined();
  });

  it.each(['hey?', "what's up?", 'thanks?'])('recalls on the question %j', text => {
    expect(classifyPreRecallGate([userMessage(text)])).toBeUndefined();
  });

  it.each([
    'hey there, I wanted to ask about the Madrid apartment search and whether Salamanca is better',
    'thanks so much, that was really helpful and I appreciate the detailed breakdown',
  ])('recalls on the longer message %j', text => {
    expect(classifyPreRecallGate([userMessage(text)])).toBeUndefined();
  });

  it.each(['maybe', 'hmm', 'so...', 'well'])('recalls on the uncertain text %j', text => {
    expect(classifyPreRecallGate([userMessage(text)])).toBeUndefined();
  });

  it('classifies only what the user typed, not an attached document', () => {
    const document = `<untrusted-document>Extracted text for lease.pdf\n${'clause '.repeat(50)}</untrusted-document>`;
    expect(
      classifyPreRecallGate([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'thanks' },
            { type: 'text', text: document },
          ],
        },
      ]),
    ).toBe('trivial_acknowledgement');
    expect(
      classifyPreRecallGate([userMessage('thanks'), { role: 'user', content: [{ type: 'text', text: document }] }]),
    ).toBe('trivial_acknowledgement');
  });

  it('recalls when there is no user message', () => {
    expect(classifyPreRecallGate([])).toBeUndefined();
    expect(classifyPreRecallGate([{ role: 'assistant', content: 'hello' }])).toBeUndefined();
  });

  it('classifies the newest user message, not an older one', () => {
    expect(classifyPreRecallGate([userMessage('remember the hotel'), userMessage('hey')])).toBe('trivial_greeting');
    expect(classifyPreRecallGate([userMessage('hey'), userMessage('remember the hotel')])).toBeUndefined();
  });
});

describe('pre-recall gate in processPreLLM', () => {
  function makeProcessor(input: {
    gateEnabled: boolean;
    recall?: jest.Mock;
    getProfile?: jest.Mock;
    listMentalModels?: jest.Mock;
    getOperation?: jest.Mock;
  }) {
    const client = makeClient(input);
    const capability = hindsightMemoryCapability({
      client,
      config: { ...CONFIG, preRecallGateEnabled: input.gateEnabled },
      logger: makeLogger(),
      sessionId: 's1',
      previousTurnId: null,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (!processor) {
      throw new Error('expected a preLLM processor');
    }
    const ephemeralProcessor = capability.preLLMEphemeralProcessors?.[0];
    if (!ephemeralProcessor) {
      throw new Error('expected a preLLM ephemeral processor');
    }
    return { client, capability, processor, ephemeralProcessor };
  }

  it('recalls a greeting when the gate is off (default behavior preserved)', async () => {
    const recall = jest.fn().mockResolvedValue({ ok: true, results: [], entities: [] });
    const { processor } = makeProcessor({ gateEnabled: false, recall });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('hey')])));
    expect(recall).toHaveBeenCalledTimes(1);
    expect(passthroughEvent(events)).toMatchObject({ stats: { outcome: 'empty' } });
  });

  it('skips every provider read on a greeting when the gate is on', async () => {
    const recall = jest.fn();
    const getProfile = jest.fn();
    const listMentalModels = jest.fn();
    const { processor } = makeProcessor({ gateEnabled: true, recall, getProfile, listMentalModels });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('hey')])));

    expect(recall).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
    expect(listMentalModels).not.toHaveBeenCalled();
    expect(passthroughEvent(events)).toMatchObject({
      type: 'aman.memory.recall',
      injected_block: null,
      stats: { outcome: 'skipped', reason: 'trivial_greeting' },
    });
  });

  it('skips on an acknowledgement and records the acknowledgement reason', async () => {
    const recall = jest.fn();
    const { processor } = makeProcessor({ gateEnabled: true, recall });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('thanks!')])));

    expect(recall).not.toHaveBeenCalled();
    expect(passthroughEvent(events)).toMatchObject({
      stats: { outcome: 'skipped', reason: 'trivial_acknowledgement' },
    });
  });

  it('recalls a history reference when the gate is on', async () => {
    const recall = jest.fn().mockResolvedValue({ ok: true, results: [], entities: [] });
    const { processor } = makeProcessor({ gateEnabled: true, recall });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('remember what you told me')])));
    expect(recall).toHaveBeenCalledTimes(1);
    expect(passthroughEvent(events)).toMatchObject({ stats: { outcome: 'empty' } });
  });

  it('recalls an uncertain message when the gate is on', async () => {
    const recall = jest.fn().mockResolvedValue({ ok: true, results: [], entities: [] });
    const { processor } = makeProcessor({ gateEnabled: true, recall });
    await collect(processor.processPreLLM(makeExecution([userMessage('hmm, not sure')])));

    expect(recall).toHaveBeenCalledTimes(1);
  });

  it('injects nothing stale on a skipped turn', async () => {
    const { processor, ephemeralProcessor } = makeProcessor({ gateEnabled: true });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('hey')])));

    const event = passthroughEvent(events);
    expect(event.injected_block).toBeNull();
    expect('screen' in event).toBe(false);
    expect('layers' in event).toBe(false);
    expect(ephemeralProcessor.processPreLLMEphemeral([{ role: 'user', content: 'hey' }])).toBeUndefined();
  });

  it('still sweeps pending retain ops on a skipped turn', async () => {
    const getOperation = jest.fn().mockResolvedValue({ ok: true, status: 'succeeded' });
    const { capability, processor } = makeProcessor({ gateEnabled: true, getOperation });
    // Seed pending through the same durable-state hydration production uses between turns.
    if (!capability.state) {
      throw new Error('expected capability state hydration');
    }
    capability.state.load({
      pending: [{ op: 'op-1', turn: 't0', attempts: 0, submitted_at: new Date().toISOString() }],
    });
    const events = await collect(processor.processPreLLM(makeExecution([userMessage('ok')])));

    expect(getOperation).toHaveBeenCalled();
    expect(passthroughEvent(events)).toMatchObject({
      stats: { outcome: 'skipped' },
      sweep: { verified: 1 },
    });
  });
});
