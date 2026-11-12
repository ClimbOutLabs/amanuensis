import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemindersApi } from '../src/remindersApi';

function recordingFetch(respond: (url: URL) => Response) {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input), 'http://localhost');
    urls.push(url.toString());
    return respond(url);
  };
  return { fetcher, urls };
}

function wireItem(id: string, sessionId: string | null) {
  return {
    id,
    what: `Reminder ${id}`,
    timezone: 'UTC',
    repeats: false,
    timing: 'Once, on Monday at 09:00',
    state: 'upcoming',
    next_due_at: '2026-11-16T09:00:00.000Z',
    last_reminded_at: null,
    last_due_at: null,
    set_at: '2026-11-12T09:00:00.000Z',
    persona_name: 'Aman',
    session_id: sessionId,
  };
}

test('reads every page and keeps the chat each reminder was set in', async () => {
  const { fetcher, urls } = recordingFetch(url =>
    url.searchParams.get('page_token') === null
      ? Response.json({ data: [wireItem('r1', 's1'), { nonsense: true }], next_page_token: 'p2' })
      : Response.json({ data: [wireItem('r2', null)] }),
  );
  const reminders = await createRemindersApi(fetcher).listReminders();

  assert.deepEqual(urls, [
    'http://localhost/api/v1/user/reminders?limit=100',
    'http://localhost/api/v1/user/reminders?limit=100&page_token=p2',
  ]);
  assert.deepEqual(
    reminders.map(reminder => [reminder.id, reminder.sessionId]),
    [
      ['r1', 's1'],
      ['r2', null],
    ],
  );
});

test("passes on the server's plain error words", async () => {
  const { fetcher } = recordingFetch(() =>
    Response.json(
      { error: { message: 'That page of your reminders is out of date. Reload to start again.' } },
      { status: 400 },
    ),
  );
  await assert.rejects(createRemindersApi(fetcher).listReminders(), {
    message: 'That page of your reminders is out of date. Reload to start again.',
  });
});
