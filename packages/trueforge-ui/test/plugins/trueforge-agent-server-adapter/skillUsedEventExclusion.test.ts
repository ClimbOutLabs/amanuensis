import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Covers the `aman.skill.used` exclusion in `toUiStreamingEvent` (chatServer.ts): the vendor
 * `TurnStreamingEvent` union has no ingestion case for this event, so it must be dropped from the
 * live SSE stream the UI consumes, the same way `aman.memory.recall` / `aman.profile.learned` /
 * `agent.context.compaction` / `document.ingestion` are dropped just above it. Also asserts that
 * dropping it does not swallow neighboring events on the same stream.
 */

interface FakeStreamItem {
  id: string;
  data: TrueForgeApi.TurnStreamingEvent;
}

function fakeSdkStream(items: FakeStreamItem[]): { withMetadata: () => AsyncIterable<FakeStreamItem> } {
  return {
    withMetadata() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const item of items) {
            yield item;
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
      createdAt: '2026-09-15T00:00:00.000Z',
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
      createdAt: '2026-09-15T00:00:01.000Z',
      state: { status: 'done', output: null, requiredActions: [], completedAt: '2026-09-15T00:00:01.000Z' },
    },
  };
}

function skillUsed(id: string): FakeStreamItem {
  return {
    id,
    data: {
      type: 'aman.skill.used',
      id: `evt_${id}`,
      kind: 'skill_read',
      skillName: 'example-skill',
      createdAt: '2026-09-15T00:00:00.500Z',
    } as unknown as TrueForgeApi.TurnStreamingEvent,
  };
}

function createFakeClient(items: FakeStreamItem[]): TrueForge {
  const fake = {
    sessions: {
      async createTurnStream() {
        return fakeSdkStream(items);
      },
    },
  };
  return fake as unknown as TrueForge;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

describe('createHarnessChatServer aman.skill.used exclusion', () => {
  it('excludes aman.skill.used from the UI-facing stream while passing other events through', async () => {
    const client = createFakeClient([
      turnCreated('1', 'trn_1'),
      skillUsed('2'),
      messageDelta('3', 'hi'),
      turnDone('4'),
    ]);
    const server = createHarnessChatServer({ client });

    const items = await collect(server.createTurn({ sessionId: 'ses_1', input: [] }));

    assert.deepEqual(
      items.map(item => item.event.type),
      ['turn.created', 'model.message.delta'],
    );
  });
});
