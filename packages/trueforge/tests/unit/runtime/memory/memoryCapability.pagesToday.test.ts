import { memoryCapability } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';
import { collect, DEFAULT_CONFIG, makeClient, makeExecution, makeLogger } from './memoryCapabilityTestKit';

/** The day the memory step hands the page loader, for one instant and time zone. */
async function dayHandedOver({ instant, timeZone }: { instant: string; timeZone: string }): Promise<unknown> {
  jest.useFakeTimers({
    now: new Date(instant),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
  });
  try {
    const loadPages = jest.fn().mockResolvedValue({
      pages: [],
      stats: { candidates: 0, loaded: 0, dropped_over_count: 0, dropped_over_budget: 0 },
      skippedFiles: [],
    });
    const client: MemoryClient = Object.assign(makeClient({}), { loadPages });
    const capability = memoryCapability({
      client,
      config: DEFAULT_CONFIG,
      logger: makeLogger(),
      sessionId: 's1',
      previousTurnId: null,
      timeZone,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) {
      throw new Error('expected a preLLM processor');
    }
    await collect(
      processor.processPreLLM(
        makeExecution([
          { role: 'user', content: 'Plan dinner with Nora.' },
          { role: 'assistant', content: 'OK.' },
          { role: 'user', content: 'What can she not eat?' },
        ]),
      ),
    );
    return loadPages.mock.calls[0]?.[0];
  } finally {
    jest.useRealTimers();
  }
}

describe('what the memory step hands the page loader', () => {
  it('gives the newest message, the earlier ones and the day in the persons time zone', async () => {
    const utc = await dayHandedOver({ instant: '2026-11-10T23:30:00Z', timeZone: 'UTC' });
    expect(utc).toMatchObject({
      message: 'What can she not eat?',
      earlierMessages: ['Plan dinner with Nora.'],
      today: '2026-11-10',
    });
    const tokyo = await dayHandedOver({ instant: '2026-11-10T23:30:00Z', timeZone: 'Asia/Tokyo' });
    expect(tokyo).toMatchObject({ today: '2026-11-11' });
  });
});
