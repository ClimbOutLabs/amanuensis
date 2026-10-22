import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { LiveConnectionLostError } from '@/utils/liveConnection.js';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Fakes the two SDK streaming calls the adapter drives (`createTurnStream`,
 * `subscribeToTurn`). Each fake stream replays a fixed list of SSE-shaped
 * items, then optionally throws to simulate a transport drop.
 */
interface FakeStreamItem {
  id: string;
  data: TrueForgeApi.TurnStreamingEvent;
}

function fakeSdkStream(
  items: FakeStreamItem[],
  failure?: () => Error,
): { withMetadata: () => AsyncIterable<FakeStreamItem> } {
  return {
    withMetadata() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const item of items) {
            yield item;
          }
          if (failure) {
            throw failure();
          }
        },
      };
    },
  };
}

function turnCreated(id: string, turnId: string): FakeStreamItem {
  return {
    id,
    data: {
      type: 'turn.created',
      id: `evt_${id}`,
      turnId,
      previousTurnId: null,
      state: { status: 'running' },
      threadId: null,
      createdAt: '2026-09-12T00:00:00.000Z',
    },
  };
}

function messageDelta(id: string, content: string): FakeStreamItem {
  return {
    id,
    data: {
      type: 'model.message.delta',
      id: `evt_${id}`,
      threadId: 'main',
      content,
    },
  };
}

function turnDone(id: string): FakeStreamItem {
  return {
    id,
    data: {
      type: 'turn.done',
      id: `evt_${id}`,
      threadId: null,
      createdAt: '2026-09-12T00:00:01.000Z',
      state: { status: 'done', output: null, requiredActions: [], completedAt: '2026-09-12T00:00:01.000Z' },
    },
  };
}

function notFoundError(): Error {
  const error = new Error('NotFoundError') as Error & { statusCode: number };
  error.name = 'NotFoundError';
  error.statusCode = 404;
  return error;
}

interface FakeClient {
  client: TrueForge;
  subscribeCalls: Array<{ turnId: string; afterSequenceNumber: number | undefined }>;
}

function createFakeClient(opts: {
  createTurn: () => { withMetadata: () => AsyncIterable<FakeStreamItem> };
  subscribeToTurn: (call: { turnId: string; afterSequenceNumber: number | undefined; callIndex: number }) => {
    withMetadata: () => AsyncIterable<FakeStreamItem>;
  };
}): FakeClient {
  const subscribeCalls: Array<{ turnId: string; afterSequenceNumber: number | undefined }> = [];
  const fake = {
    sessions: {
      async createTurnStream() {
        return opts.createTurn();
      },
      async subscribeToTurn(_sessionId: string, turnId: string, request: { afterSequenceNumber?: number }) {
        const callIndex = subscribeCalls.length;
        subscribeCalls.push({ turnId, afterSequenceNumber: request.afterSequenceNumber });
        return opts.subscribeToTurn({ turnId, afterSequenceNumber: request.afterSequenceNumber, callIndex });
      },
    },
  };
  return { client: fake as unknown as TrueForge, subscribeCalls };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

describe('createHarnessChatServer turn stream reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resubscribes from the right cursor after a transport drop, with no duplicate events and no error', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () =>
        fakeSdkStream(
          [turnCreated('1', 'trn_1'), messageDelta('2', 'hel'), messageDelta('3', 'lo')],
          () => new TypeError('network error'),
        ),
      subscribeToTurn: () => fakeSdkStream([messageDelta('4', ' world'), turnDone('5')]),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.sequenceNumber),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created', 'model.message.delta', 'model.message.delta', 'model.message.delta'],
    );
    assert.equal(subscribeCalls.length, 1);
    assert.deepEqual(subscribeCalls[0], { turnId: 'trn_1', afterSequenceNumber: 3 });
  });

  it('never resubscribes when the caller aborts the turn deliberately', async () => {
    const controller = new AbortController();
    let subscribeCallCount = 0;
    const { client } = createFakeClient({
      createTurn: () => ({
        withMetadata() {
          return {
            async *[Symbol.asyncIterator]() {
              yield turnCreated('1', 'trn_1');
              controller.abort();
              const abortError = new DOMException('The operation was aborted', 'AbortError');
              throw abortError;
            },
          };
        },
      }),
      subscribeToTurn: () => {
        subscribeCallCount += 1;
        return fakeSdkStream([messageDelta('2', 'unexpected')]);
      },
    });
    const server = createHarnessChatServer({ client });

    await assert.rejects(
      collect(server.createTurn({ sessionId: 'ses_1', input: [], abortSignal: controller.signal })),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(subscribeCallCount, 0);
  });

  it('completes cleanly when the turn is already done on resubscribe', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () => fakeSdkStream([turnCreated('1', 'trn_1')], () => new TypeError('network error')),
      // Turn already finished; resubscribe replays the final event.
      subscribeToTurn: () => fakeSdkStream([turnDone('2')]),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created'],
    );
    assert.equal(subscribeCalls.length, 1);
    assert.deepEqual(subscribeCalls[0], { turnId: 'trn_1', afterSequenceNumber: 1 });
  });

  it('gives up and surfaces the error once retries are exhausted', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () => fakeSdkStream([turnCreated('1', 'trn_1')], () => new TypeError('network error')),
      subscribeToTurn: () => fakeSdkStream([], () => new TypeError('persistent network error')),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    // Fake timers advance synchronously with respect to this test; attach a
    // handler up front so the eventual rejection is never briefly unhandled.
    runPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);

    await assert.rejects(
      runPromise,
      (error: unknown) =>
        error instanceof LiveConnectionLostError &&
        error.cause instanceof Error &&
        error.cause.message === 'persistent network error',
    );
    // Bounded: a persistently failing transport must stop retrying rather than loop forever.
    assert.ok(
      subscribeCalls.length >= 2 && subscribeCalls.length <= 10,
      `expected a bounded retry count, got ${subscribeCalls.length}`,
    );
  });

  it('gives up immediately without exhausting retries when the server reports the turn is gone', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () => fakeSdkStream([turnCreated('1', 'trn_1')], () => new TypeError('network error')),
      subscribeToTurn: () => fakeSdkStream([], () => notFoundError()),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    runPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);

    await assert.rejects(runPromise, (error: unknown) => error instanceof Error && error.name === 'NotFoundError');
    assert.equal(subscribeCalls.length, 1);
  });

  it('subscribeToTurn itself reconnects across a transport drop mid-stream', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () => fakeSdkStream([]),
      subscribeToTurn: ({ callIndex }) =>
        callIndex === 0
          ? fakeSdkStream([messageDelta('11', 'a')], () => new TypeError('network error'))
          : fakeSdkStream([messageDelta('12', 'b'), turnDone('13')]),
    });
    const server = createHarnessChatServer({ client });
    assert.ok(server.subscribeToTurn);

    const runPromise = collect(
      server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1', afterSequenceNumber: 10 }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.sequenceNumber),
      [11, 12],
    );
    assert.deepEqual(subscribeCalls, [
      { turnId: 'trn_1', afterSequenceNumber: 10 },
      { turnId: 'trn_1', afterSequenceNumber: 11 },
    ]);
  });

  it('reconnects when a stream completes cleanly without turn.done', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () =>
        fakeSdkStream(
          [turnCreated('1', 'trn_1'), messageDelta('2', 'hello'), messageDelta('3', 'world')],
          undefined, // No error, just clean completion
        ),
      subscribeToTurn: () => fakeSdkStream([messageDelta('4', '!'), turnDone('5')]),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.sequenceNumber),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created', 'model.message.delta', 'model.message.delta', 'model.message.delta'],
    );
    assert.equal(subscribeCalls.length, 1);
    assert.deepEqual(subscribeCalls[0], { turnId: 'trn_1', afterSequenceNumber: 3 });
  });

  it('retries when a resubscribe attempt itself ends cleanly without turn.done', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () =>
        fakeSdkStream(
          [turnCreated('1', 'trn_1'), messageDelta('2', 'a')],
          undefined, // Clean completion without turn.done
        ),
      subscribeToTurn: ({ callIndex }) =>
        callIndex === 0
          ? fakeSdkStream([messageDelta('3', 'b')], undefined) // Clean end without turn.done again
          : fakeSdkStream([messageDelta('4', 'c'), turnDone('5')]),
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.sequenceNumber),
      [1, 2, 3, 4],
    );
    assert.equal(subscribeCalls.length, 2);
    assert.deepEqual(subscribeCalls[0], { turnId: 'trn_1', afterSequenceNumber: 2 });
    assert.deepEqual(subscribeCalls[1], { turnId: 'trn_1', afterSequenceNumber: 3 });
  });

  it('does not reconnect when a stream completes cleanly after turn.done', async () => {
    let subscribeCallCount = 0;
    const { client } = createFakeClient({
      createTurn: () =>
        fakeSdkStream([
          turnCreated('1', 'trn_1'),
          messageDelta('2', 'hello'),
          messageDelta('3', 'world'),
          turnDone('4'),
        ]),
      subscribeToTurn: () => {
        subscribeCallCount += 1;
        return fakeSdkStream([messageDelta('5', 'unexpected')]);
      },
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const items = await runPromise;

    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created', 'model.message.delta', 'model.message.delta'],
    );
    assert.equal(subscribeCallCount, 0);
  });

  it('resets attempt counter on progress, allowing full retries on next drop', async () => {
    const { client, subscribeCalls } = createFakeClient({
      createTurn: () =>
        fakeSdkStream([turnCreated('1', 'trn_1'), messageDelta('2', 'a')], () => new TypeError('first network error')),
      subscribeToTurn: ({ callIndex }) => {
        if (callIndex === 0) {
          // First reconnect: recovers with events (attempt counter resets)
          return fakeSdkStream(
            [messageDelta('3', 'b'), messageDelta('4', 'c')],
            () => new TypeError('second network error'),
          );
        } else {
          // Second reconnect: should still have the full budget (attempt was reset to 0)
          // Simulate reaching the max attempts and failing
          return fakeSdkStream([], () => new TypeError('recovery failed'));
        }
      },
    });
    const server = createHarnessChatServer({ client });

    const runPromise = collect(server.createTurn({ sessionId: 'ses_1', input: [] }));
    runPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);

    await assert.rejects(runPromise, (error: unknown) => error instanceof Error);
    // Should have at least 2 subscribe calls (first drop + first recovery), then
    // the recovery itself failed, triggering more reconnects. If attempt counter
    // was NOT reset, we'd exhaust faster; with the reset, we get more calls.
    assert.ok(
      subscribeCalls.length >= 2,
      `expected multiple resubscribe calls from attempt reset, got ${subscribeCalls.length}`,
    );
  });
});
