import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeliveriesApi } from '../src/deliveriesApi';

type Seen = { method: string; url: string; body: unknown };

function recordingFetch(respond: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    const body: unknown = request.method === 'GET' ? undefined : await request.json();
    const seen = { method: request.method, url: request.url, body };
    calls.push(seen);
    return respond(seen);
  };
  return { fetcher, calls };
}

const WIRE_ITEM = {
  id: 'd1',
  kind: 'reminder',
  level: 'nudge',
  text: 'Call the dentist',
  reason: 'You asked to be reminded on Monday.',
  link: { type: 'chat', session_id: 's1' },
  created_at: '2026-10-31T10:00:00.000Z',
  seen_at: null,
  attempts: [],
};

test('lists a page of the feed and reads the next page token', async () => {
  const { fetcher, calls } = recordingFetch(() =>
    Response.json({ data: [WIRE_ITEM, { nonsense: true }], next_page_token: 'n1' }),
  );
  const page = await createDeliveriesApi(fetcher).list({ limit: 25, pageToken: 'p0' });

  assert.equal(calls[0]?.url, 'http://localhost/api/v1/user/deliveries?limit=25&page_token=p0');
  assert.deepEqual(page.items, [
    {
      id: 'd1',
      kind: 'reminder',
      text: 'Call the dentist',
      reason: 'You asked to be reminded on Monday.',
      link: { type: 'chat', sessionId: 's1' },
      createdAt: '2026-10-31T10:00:00.000Z',
      seenAt: null,
    },
  ]);
  assert.equal(page.nextPageToken, 'n1');
});

test('reads the unread count, and marks items seen on the server', async () => {
  const { fetcher, calls } = recordingFetch(() => Response.json({ data: { unread_count: 2 } }));
  const api = createDeliveriesApi(fetcher);
  assert.equal(await api.unreadCount(), 2);
  assert.equal(await api.markSeen(['a', 'b']), 2);
  assert.deepEqual(
    calls.map(call => [call.method, new URL(call.url).pathname, call.body]),
    [
      ['GET', '/api/v1/user/deliveries/unread-count', undefined],
      ['POST', '/api/v1/user/deliveries/seen', { ids: ['a', 'b'] }],
    ],
  );
});

test('an item that is not the person’s reads as missing, and an unknown link is dropped, not drawn wrong', async () => {
  const missing = createDeliveriesApi(async () => Response.json({ error: { message: 'gone' } }, { status: 404 }));
  assert.equal(await missing.get('x'), null);
  const odd = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_ITEM, link: { type: 'carrier_pigeon' } } }),
  );
  assert.equal((await odd.get('d1'))?.link, null);
});

test('saves a push device with its keys and removes it by address', async () => {
  const { fetcher, calls } = recordingFetch(() =>
    Response.json({ data: { public_key: 'KEY', id: 'x' } }, { status: 200 }),
  );
  const api = createDeliveriesApi(fetcher);
  assert.equal(await api.pushPublicKey(), 'KEY');
  assert.equal(
    await api.savePushDevice({ endpoint: 'https://push.example.test/a', p256dh: 'p', auth: 'a', label: 'This device' }),
    'saved',
  );
  await api.removePushDevice('https://push.example.test/a');
  assert.deepEqual(calls[1]?.body, {
    endpoint: 'https://push.example.test/a',
    keys: { p256dh: 'p', auth: 'a' },
    label: 'This device',
  });
  assert.equal(calls[2]?.method, 'DELETE');
  // The address goes in the body, never the query string, so it stays out of request logs.
  assert.equal(new URL(calls[2]?.url ?? '').search, '');
  assert.deepEqual(calls[2]?.body, { endpoint: 'https://push.example.test/a' });
});

test('asks the server whether this device still gets notices, with the address in the body', async () => {
  const { fetcher, calls } = recordingFetch(seen =>
    Response.json({ data: { saved: JSON.stringify(seen.body).includes('/kept') } }),
  );
  const api = createDeliveriesApi(fetcher);
  assert.equal(await api.pushDeviceSaved('https://push.example.test/kept'), true);
  assert.equal(await api.pushDeviceSaved('https://push.example.test/dropped'), false);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(new URL(calls[0]?.url ?? '').pathname, '/api/v1/user/push/subscriptions/lookup');
  assert.equal(new URL(calls[0]?.url ?? '').search, '');
  assert.deepEqual(calls[0]?.body, { endpoint: 'https://push.example.test/kept' });
});

test('reports an address another account holds, and marks everything seen in one call', async () => {
  const taken = createDeliveriesApi(async () =>
    Response.json({ error: { message: 'Another account.' } }, { status: 409 }),
  );
  assert.equal(
    await taken.savePushDevice({ endpoint: 'https://x.test/a', p256dh: 'p', auth: 'a', label: 'x' }),
    'taken',
  );

  const { fetcher, calls } = recordingFetch(() => Response.json({ data: { unread_count: 0 } }));
  assert.equal(await createDeliveriesApi(fetcher).markAllSeen(), 0);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(new URL(calls[0]?.url ?? '').pathname, '/api/v1/user/deliveries/seen-all');
});

test('push is off when the server sends no key, and a server error says what it said', async () => {
  const off = createDeliveriesApi(async () => Response.json({ data: { public_key: null } }));
  assert.equal(await off.pushPublicKey(), null);
  const failing = createDeliveriesApi(async () =>
    Response.json({ error: { message: 'Ask the person who runs it.' } }, { status: 400 }),
  );
  await assert.rejects(
    failing.savePushDevice({ endpoint: 'https://x.test/a', p256dh: 'p', auth: 'a', label: 'x' }),
    /Ask the person who runs it/,
  );
});
