import { createClient } from 'redis';
import { RequestReplyExecutor } from '../../src/request-reply/executor';
import type { JSONReply } from '../../src/request-reply/types';
import { heartbeatKey } from '../../src/request-reply/utils';
import { makeSilentLogger } from '../core/harnessMocks';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('RequestReplyExecutor heartbeat', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createExecutor(input: {
    requestHandler: (path: string) => Promise<JSONReply>;
    heartbeatIntervalMs?: number;
  }): {
    executor: RequestReplyExecutor;
    redis: ReturnType<typeof createClient>;
    subscriber: ReturnType<typeof createClient>;
    setSpy: jest.SpyInstance;
    deliver: (message: string) => void;
  } {
    const redis = createClient({ url: 'redis://127.0.0.1:6379', RESP: 2 });
    const subscriber = createClient({ url: 'redis://127.0.0.1:6379', RESP: 2 });
    const setSpy = jest.spyOn(redis, 'set').mockResolvedValue('OK');
    let listener: ((message: string, channel: string) => unknown) | undefined;
    jest.spyOn(subscriber, 'subscribe').mockImplementation(async (_channel, messageListener) => {
      listener = messageListener;
    });
    jest.spyOn(subscriber, 'unsubscribe').mockResolvedValue(undefined);
    Object.defineProperty(subscriber, 'isReady', { configurable: true, get: () => true });
    const executor = new RequestReplyExecutor({
      executorId: 'exec-1',
      redis,
      subscriberClient: subscriber,
      requestHandler: input.requestHandler,
      logger: makeSilentLogger(),
      ...(input.heartbeatIntervalMs !== undefined
        ? { options: { heartbeatIntervalMs: input.heartbeatIntervalMs } }
        : {}),
    });
    const deliver = (message: string): void => {
      if (listener === undefined) {
        throw new Error('executor did not subscribe');
      }
      listener(message, 'tfg:rr:req:exec-1');
    };
    return { executor, redis, subscriber, setSpy, deliver };
  }

  function heartbeatCalls(setSpy: jest.SpyInstance): unknown[][] {
    return setSpy.mock.calls.filter(args => args[0] === heartbeatKey('exec-1'));
  }

  it('gives the heartbeat key three intervals of TTL so one delayed beat cannot expire it', async () => {
    const { executor, setSpy } = createExecutor({
      requestHandler: async () => ({ status: 200, headers: {}, body: {} }),
    });
    await executor.init();

    const calls = heartbeatCalls(setSpy);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[2]).toEqual({ PX: 15_000 });
    await executor.close();
  });

  it('keeps the heartbeat beating during drain until running requests settle', async () => {
    let releaseHandler: ((reply: JSONReply) => void) | undefined;
    const { executor, setSpy, deliver } = createExecutor({
      heartbeatIntervalMs: 20,
      requestHandler: () =>
        new Promise<JSONReply>(resolve => {
          releaseHandler = resolve;
        }),
    });
    await executor.init();
    deliver(JSON.stringify({ replyKey: 'reply-1', path: '/ping', body: { ping: true } }));

    const beatsBeforeDrain = heartbeatCalls(setSpy).length;
    const drained = executor.drain();
    await sleep(250);
    expect(heartbeatCalls(setSpy).length).toBeGreaterThan(beatsBeforeDrain + 2);
    if (releaseHandler === undefined) {
      throw new Error('request handler was not called');
    }
    releaseHandler({ status: 200, headers: {}, body: { pong: true } });
    await drained;

    const beatsAfterDrain = heartbeatCalls(setSpy).length;
    await sleep(120);
    expect(heartbeatCalls(setSpy).length).toBe(beatsAfterDrain);
  });

  it('keeps the heartbeat beating when a subscription error lands during drain until running requests settle', async () => {
    let releaseHandler: ((reply: JSONReply) => void) | undefined;
    const { executor, subscriber, setSpy, deliver } = createExecutor({
      heartbeatIntervalMs: 20,
      requestHandler: () =>
        new Promise<JSONReply>(resolve => {
          releaseHandler = resolve;
        }),
    });
    await executor.init();
    deliver(JSON.stringify({ replyKey: 'reply-1', path: '/ping', body: { ping: true } }));

    const beatsBeforeDrain = heartbeatCalls(setSpy).length;
    const drained = executor.drain();
    subscriber.emit('error', new Error('subscription dropped'));
    await sleep(250);
    expect(heartbeatCalls(setSpy).length).toBeGreaterThan(beatsBeforeDrain + 2);
    if (releaseHandler === undefined) {
      throw new Error('request handler was not called');
    }
    releaseHandler({ status: 200, headers: {}, body: { pong: true } });
    await drained;

    const beatsAfterDrain = heartbeatCalls(setSpy).length;
    await sleep(120);
    expect(heartbeatCalls(setSpy).length).toBe(beatsAfterDrain);
  });
});
