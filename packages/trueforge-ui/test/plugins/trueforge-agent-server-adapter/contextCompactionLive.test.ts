import { afterEach, describe, expect, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import {
  clearContextCompaction,
  isContextCompacting,
  subscribeToContextCompaction,
} from '@/utils/contextCompactionLive.js';

const sessionId = 'compacting-session';
const createdAt = '2026-10-23T08:00:00.000Z';

const turnCreated = {
  type: 'turn.created',
  id: 'turn-created',
  turn_id: 'turn-1',
  previous_turn_id: null,
  input: [{ type: 'user.message', content: 'and then?' }],
  state: { status: 'running' },
  thread_id: null,
  created_at: createdAt,
};
const compactionStarted = {
  type: 'agent.context.compaction_started',
  id: 'compaction-started',
  thread_id: 'main',
  mode: 'conversation',
  tokens_before: 60000,
  created_at: createdAt,
};
const compactionDone = {
  type: 'agent.context.compaction',
  id: 'compaction-done',
  thread_id: 'main',
  mode: 'conversation',
  tokens_before: 60000,
  tokens_after: 9000,
  summary_chars: 2000,
  outcome: 'applied',
  created_at: createdAt,
};
const replyDelta = {
  type: 'model.message.delta',
  id: 'reply',
  thread_id: 'main',
  content: 'So far',
  created_at: createdAt,
};
const turnDone = {
  type: 'turn.done',
  id: 'turn-done',
  state: { status: 'done', output: null, required_actions: [], completed_at: createdAt },
  thread_id: null,
  created_at: createdAt,
};

function sse(events: readonly unknown[]): string {
  return events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n`).join('\n');
}

/** Runs one turn over the given stream and returns each change to "this chat is compacting". */
async function compactingChanges(events: readonly unknown[]): Promise<{ changes: boolean[]; uiTypes: string[] }> {
  const fetchMock: typeof fetch = async () =>
    new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
  const harness = createHarnessChatServer({ baseUrl: 'http://test.local', fetch: fetchMock });
  const changes: boolean[] = [];
  const unsubscribe = subscribeToContextCompaction(() => changes.push(isContextCompacting(sessionId)));
  const uiTypes: string[] = [];
  try {
    for await (const item of harness.createTurn({
      sessionId,
      input: [{ type: 'user.message', content: 'and then?' }],
    })) {
      uiTypes.push(item.event.type);
    }
  } finally {
    unsubscribe();
  }
  return { changes, uiTypes };
}

describe('compaction on the live turn stream', () => {
  afterEach(() => {
    clearContextCompaction();
  });

  it('marks the chat as compacting from the start event until compaction ends', async () => {
    const { changes, uiTypes } = await compactingChanges([
      turnCreated,
      compactionStarted,
      compactionDone,
      replyDelta,
      turnDone,
    ]);
    expect(changes).toEqual([true, false]);
    // The vendor chat pipeline has no case for either event, so neither reaches it.
    expect(uiTypes).toEqual(['turn.created', 'model.message.delta']);
  });

  it('clears when the reply starts or the turn ends without a compaction end', async () => {
    expect((await compactingChanges([turnCreated, compactionStarted, replyDelta, turnDone])).changes).toEqual([
      true,
      false,
    ]);
    expect((await compactingChanges([turnCreated, compactionStarted, turnDone])).changes).toEqual([true, false]);
  });
});
