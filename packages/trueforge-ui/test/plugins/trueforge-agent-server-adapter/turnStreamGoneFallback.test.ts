import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';
import { ReplyStoppedByRestartError } from '@/utils/liveConnection.js';

/** Minimal SSE-shaped stream the adapter consumes via `withMetadata()`. */
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

function streamGoneError(withStatusCode: boolean): Error {
  const error = new Error(
    'Request failed (412): Cannot read from stream, stream does not exist anymore: tfg:agent:turn:trn_1:3',
  ) as Error & { statusCode?: number };
  if (withStatusCode) {
    error.statusCode = 412;
  }
  return error;
}

function doneTurn(status: 'done' | 'error' | 'running'): TrueForgeApi.Turn {
  const state =
    status === 'running'
      ? { status: 'running' as const }
      : {
          status,
          completedAt: '2026-09-12T00:00:01.000Z',
          output: null,
          requiredActions: [],
          ...(status === 'error' ? { error: { message: 'tool exploded' } } : {}),
        };
  return {
    id: 'trn_1',
    sessionId: 'ses_1',
    createdAt: '2026-09-12T00:00:00.000Z',
    input: [],
    previousTurnId: null,
    state,
  } as TrueForgeApi.Turn;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

describe('turn stream 412 (dead stream) REST fallback', () => {
  it('falls back to REST and completes from the persisted done state', async () => {
    let subscribeCalls = 0;
    const fake = {
      sessions: {
        async subscribeToTurn() {
          subscribeCalls += 1;
          throw streamGoneError(true);
        },
        async getTurn(_sessionId: string, turnId: string) {
          assert.equal(turnId, 'trn_1');
          return { data: doneTurn('done') };
        },
      },
    } as unknown as TrueForge;
    const server = createHarnessChatServer({ client: fake });
    assert.ok(server.subscribeToTurn);

    const items = await collect(server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' }));

    assert.equal(subscribeCalls, 1);
    assert.equal(items.length, 1);
    const [final] = items;
    assert.ok(final);
    assert.equal(final.event.type, 'turn.done');
    assert.equal(final.event.state.status, 'done');
    // The raw 412 text never leaks into the surfaced event.
    assert.ok(!JSON.stringify(final.event).includes('stream does not exist'));
  });

  it('surfaces the persisted error state so the retry banner can engage', async () => {
    const fake = {
      sessions: {
        async subscribeToTurn() {
          throw streamGoneError(true);
        },
        async getTurn() {
          return { data: doneTurn('error') };
        },
      },
    } as unknown as TrueForge;
    const server = createHarnessChatServer({ client: fake });
    assert.ok(server.subscribeToTurn);

    const items = await collect(server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' }));

    assert.equal(items.length, 1);
    const [final] = items;
    assert.ok(final);
    assert.equal(final.event.type, 'turn.done');
    assert.equal(final.event.state.status, 'error');
  });

  it('detects the 412 from the message alone when no status code is present', async () => {
    const fake = {
      sessions: {
        async subscribeToTurn() {
          throw streamGoneError(false);
        },
        async getTurn() {
          return { data: doneTurn('done') };
        },
      },
    } as unknown as TrueForge;
    const server = createHarnessChatServer({ client: fake });
    assert.ok(server.subscribeToTurn);

    const items = await collect(server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' }));
    assert.equal(items.length, 1);
    const [first] = items;
    assert.ok(first);
    assert.equal(first.event.type, 'turn.done');
  });

  it('ends a turn the restart left running and reports it as stopped by the restart', async () => {
    const requests: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      requests.push(`${method} ${url.pathname}`);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/subscribe')) {
        return json(412, { error: { message: 'Cannot read from stream, stream does not exist anymore' } });
      }
      if (url.pathname.endsWith('/cancel')) return json(200, {});
      return json(200, {
        data: {
          id: 'trn_1',
          session_id: 'ses_1',
          created_at: '2026-09-12T00:00:00.000Z',
          input: [],
          previous_turn_id: null,
          state: { status: 'running' },
        },
      });
    };
    const server = createHarnessChatServer({ client: createTrueForgeClient({ fetch: fetchMock }) });
    assert.ok(server.subscribeToTurn);

    await assert.rejects(
      collect(server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' })),
      (error: unknown) => error instanceof ReplyStoppedByRestartError,
    );
    // Cancelled as the person would, so the next send is not refused as still running.
    assert.ok(requests.includes('POST /api/v1/sessions/ses_1/cancel'), requests.join(', '));
  });

  it('falls back on resubscribe inside createTurn, without retrying the dead stream', async () => {
    let subscribeCalls = 0;
    const fake = {
      sessions: {
        async createTurnStream() {
          return fakeSdkStream([turnCreated('1', 'trn_1')], () => new TypeError('network error'));
        },
        async subscribeToTurn() {
          subscribeCalls += 1;
          throw streamGoneError(true);
        },
        async getTurn() {
          return { data: doneTurn('done') };
        },
      },
    } as unknown as TrueForge;
    const server = createHarnessChatServer({ client: fake });

    const items = await collect(server.createTurn({ sessionId: 'ses_1', input: [] }));

    assert.equal(subscribeCalls, 1);
    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created', 'turn.done'],
    );
  });

  it('survives a server restart that wipes the in-memory stream store mid-turn', async () => {
    // Faithful miniature of the real server: completed streams live in memory
    // (expire after TURN_STREAM_POST_COMPLETION_TTL_SECONDS); the persisted
    // turn lives in the database. A restart wipes the streams but not the turn.
    const streams = new Map<string, FakeStreamItem[]>();
    const persisted = doneTurn('done');
    const fake = {
      sessions: {
        async subscribeToTurn(_sessionId: string, turnId: string) {
          const items = streams.get(turnId);
          if (items === undefined) {
            throw streamGoneError(true);
          }
          return fakeSdkStream(items);
        },
        async getTurn() {
          return { data: persisted };
        },
      },
    } as unknown as TrueForge;
    const server = createHarnessChatServer({ client: fake });
    assert.ok(server.subscribeToTurn);

    // The turn completed while the client was away; its stream replay exists...
    streams.set('trn_1', []);
    // ...then Testinatrix restarts and the in-memory stream is gone.
    streams.clear();

    const items = await collect(server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' }));

    assert.equal(items.length, 1);
    const [final] = items;
    assert.ok(final);
    assert.equal(final.event.type, 'turn.done');
    assert.equal(final.event.state.status, 'done');
    const surfaced = JSON.stringify(final.event);
    assert.ok(!surfaced.includes('412'));
    assert.ok(!surfaced.includes('stream does not exist'));
    assert.ok(!surfaced.includes('tfg:agent:turn'));
  });
});
