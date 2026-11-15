import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatAnswerMarksApi } from '../src/chatAnswerMarksApi';

type Seen = { method: string; url: string };

function recordingFetch(respond: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    const seen = { method: request.method, url: request.url };
    calls.push(seen);
    return respond(seen);
  };
  return { fetcher, calls };
}

const ANSWERED = {
  id: 'chat-a',
  metadata: { latest_answer_at: '2026-11-03T12:00:00.000Z', is_reminders: 'true' },
};
const UNANSWERED = { id: 'chat-b', metadata: {} };
const NO_METADATA = { id: 'chat-c' };

test('reads the latest answer time of each chat that has one', async () => {
  const { fetcher, calls } = recordingFetch(() =>
    Response.json({ data: [ANSWERED, UNANSWERED, NO_METADATA, { nonsense: true }], pagination: {} }),
  );
  const marks = await createChatAnswerMarksApi(fetcher).listAnswerMarks();

  assert.equal(calls[0]?.url, 'http://localhost/api/v1/sessions?limit=25&order=desc');
  assert.deepEqual(marks, [{ sessionId: 'chat-a', answeredAt: '2026-11-03T12:00:00.000Z' }]);
});

test('follows page tokens until the pages run out', async () => {
  const { fetcher, calls } = recordingFetch(seen =>
    seen.url.includes('page_token')
      ? Response.json({
          data: [{ id: 'chat-z', metadata: { latest_answer_at: '2026-11-03T09:00:00.000Z' } }],
          pagination: {},
        })
      : Response.json({ data: [ANSWERED], pagination: { next_page_token: 'tok-2' } }),
  );
  const marks = await createChatAnswerMarksApi(fetcher).listAnswerMarks();

  assert.equal(calls.length, 2);
  assert.deepEqual(marks, [
    { sessionId: 'chat-a', answeredAt: '2026-11-03T12:00:00.000Z' },
    { sessionId: 'chat-z', answeredAt: '2026-11-03T09:00:00.000Z' },
  ]);
});
