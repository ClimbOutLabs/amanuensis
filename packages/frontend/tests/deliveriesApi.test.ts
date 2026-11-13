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

const WIRE_REACH = {
  data: {
    settings: {
      noticing_on: true,
      channels: { texts: false, calls: false },
      always_important: [
        { address: 'dana@example.com', name: 'Dana', source: 'memory', added_at: '2026-11-01T00:00:00.000Z' },
      ],
      dismissed_suggestions: ['sam@example.com'],
      call_kinds: ['travel', 'unknown_kind'],
      call_for_urgent_reminders: true,
      quiet_hours: { enabled: true, start: '21:00', end: '08:00' },
      timezone: 'Europe/Paris',
      max_nudges_per_day: 4,
      min_hours_between_calls: 6,
      travel_lead_minutes: 90,
      approval_wait_minutes: 15,
    },
    saved: true,
    availability: {
      texts: { available: false, note: 'Texts are not set up yet.', problem: null },
      calls: { available: false, note: 'Phone calls are not set up yet.', problem: null },
    },
    max_levels: { travel: 'call', bill_due: 'nudge', other: 'call' },
    mail_problem: null,
  },
};

test('reads Reach me settings into the app shape, dropping what it does not know', async () => {
  const { fetcher, calls } = recordingFetch(() => Response.json(WIRE_REACH));
  const view = await createDeliveriesApi(fetcher).reach.get();

  assert.equal(new URL(calls[0]?.url ?? '').pathname, '/api/v1/user/reach');
  assert.equal(view.saved, true);
  assert.deepEqual(view.settings.callKinds, ['travel']);
  assert.deepEqual(view.settings.alwaysImportant, [
    { address: 'dana@example.com', name: 'Dana', source: 'memory', addedAt: '2026-11-01T00:00:00.000Z' },
  ]);
  assert.equal(view.settings.timezone, 'Europe/Paris');
  assert.equal(view.settings.noticingOn, true);
  assert.deepEqual(view.maxLevels, { travel: 'call', bill_due: 'nudge' });
  assert.equal(view.availability.calls.note, 'Phone calls are not set up yet.');
  assert.equal(view.mailProblem, null);
  assert.equal(view.mailSource, null);
  assert.equal(view.calendarProblem, null);
  const calendar = createDeliveriesApi(async () =>
    Response.json({
      data: { ...WIRE_REACH.data, calendar_problem: { since: '2026-11-05T14:00:00.000Z', kind: 'google_sign_in' } },
    }),
  );
  assert.deepEqual((await calendar.reach.get()).calendarProblem, {
    since: '2026-11-05T14:00:00.000Z',
    kind: 'google_sign_in',
  });
  const watched = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, mail_source: 'google' } }),
  );
  assert.equal((await watched.reach.get()).mailSource, 'google');
});

test('reads a problem with texts the server reports, and refuses a channel that leaves it out', async () => {
  const words = 'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.';
  const texts = { available: true, note: 'Texts travel through Twilio and the phone company.', problem: words };
  const api = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, availability: { ...WIRE_REACH.data.availability, texts } } }),
  );
  assert.deepEqual((await api.reach.get()).availability.texts, texts);
  const { problem: _left, ...older } = texts;
  const missing = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, availability: { ...WIRE_REACH.data.availability, texts: older } } }),
  );
  await assert.rejects(missing.reach.get(), /could not be read\. Reload the page\./);
});

test('reads the mail trouble the server reports, and treats a kind it does not know as other trouble', async () => {
  const problem = { since: '2026-11-05T14:00:00.000Z', kind: 'too_slow' };
  const slow = createDeliveriesApi(async () => Response.json({ data: { ...WIRE_REACH.data, mail_problem: problem } }));
  assert.deepEqual((await slow.reach.get()).mailProblem, problem);
  for (const kind of ['google_sign_in', 'email_password']) {
    const own = createDeliveriesApi(async () =>
      Response.json({ data: { ...WIRE_REACH.data, mail_problem: { ...problem, kind } } }),
    );
    assert.deepEqual((await own.reach.get()).mailProblem, { since: problem.since, kind });
  }
  const odd = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, mail_problem: { ...problem, kind: 'new_kind' } } }),
  );
  assert.deepEqual((await odd.reach.get()).mailProblem, { since: problem.since, kind: 'other' });
  const garbled = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, mail_problem: { ...problem, since: 'last Tuesday' } } }),
  );
  await assert.rejects(garbled.reach.get(), /could not be read\. Reload the page\./);
  const missing = createDeliveriesApi(async () => {
    const { mail_problem: _left, ...rest } = WIRE_REACH.data;
    return Response.json({ data: rest });
  });
  await assert.rejects(missing.reach.get(), /could not be read\. Reload the page\./);
});

test('says the settings could not be read when the server leaves a field out, instead of filling in defaults', async () => {
  const { max_nudges_per_day: _dropped, ...partial } = WIRE_REACH.data.settings;
  const broken = createDeliveriesApi(async () => Response.json({ data: { ...WIRE_REACH.data, settings: partial } }));
  await assert.rejects(broken.reach.get(), /could not be read\. Reload the page\./);
  const noQuiet = createDeliveriesApi(async () =>
    Response.json({ data: { ...WIRE_REACH.data, settings: { ...WIRE_REACH.data.settings, quiet_hours: {} } } }),
  );
  await assert.rejects(noQuiet.reach.get(), /could not be read\. Reload the page\./);
});

test('reads a sender only as the server wrote it, never guessing where it came from or its name', async () => {
  const withSender = (sender: Record<string, unknown>) =>
    createDeliveriesApi(async () =>
      Response.json({
        data: { ...WIRE_REACH.data, settings: { ...WIRE_REACH.data.settings, always_important: [sender] } },
      }),
    );
  const base = { address: 'dana@example.com', source: 'settings', added_at: '2026-11-01T00:00:00.000Z' };
  const unnamed = await withSender(base).reach.get();
  assert.equal(unnamed.settings.alwaysImportant[0]?.name, null);
  await assert.rejects(
    withSender({ ...base, source: 'somewhere' }).reach.get(),
    /could not be read\. Reload the page\./,
  );
  await assert.rejects(withSender({ ...base, name: 42 }).reach.get(), /could not be read\. Reload the page\./);
});

test('saves Reach me settings in the wire shape and shows the server message when it refuses', async () => {
  const { fetcher, calls } = recordingFetch(() => Response.json(WIRE_REACH));
  const api = createDeliveriesApi(fetcher);
  const view = await api.reach.get();
  await api.reach.save(view.settings);

  assert.equal(calls[1]?.method, 'PUT');
  const body: unknown = calls[1]?.body;
  const sent = typeof body === 'object' && body !== null && 'settings' in body ? body.settings : undefined;
  assert.ok(typeof sent === 'object' && sent !== null);
  assert.deepEqual('channels' in sent ? sent.channels : undefined, { texts: false, calls: false });
  assert.equal('noticing_on' in sent ? sent.noticing_on : undefined, true);
  assert.deepEqual('call_kinds' in sent ? sent.call_kinds : undefined, ['travel']);
  assert.deepEqual('always_important' in sent ? sent.always_important : undefined, [
    { address: 'dana@example.com', name: 'Dana', source: 'memory', added_at: '2026-11-01T00:00:00.000Z' },
  ]);

  const refusing = createDeliveriesApi(async () =>
    Response.json({ error: { message: 'Phone calls are not set up yet. Leave calls off for now.' } }, { status: 400 }),
  );
  await assert.rejects(refusing.reach.save(view.settings), /Leave calls off for now/);
});

test('tries a channel and reads how many devices a push notice reached', async () => {
  const { fetcher, calls } = recordingFetch(() =>
    Response.json({ data: { delivery_id: 'd9', devices_reached: 2 } }, { status: 201 }),
  );
  const result = await createDeliveriesApi(fetcher).reach.test('push');
  assert.deepEqual(result, { devicesReached: 2 });
  assert.deepEqual(calls[0]?.body, { channel: 'push' });
});

test('walks the text number flow over the texts routes and reads the status in plain fields', async () => {
  const wire = {
    phone: '+15550111',
    confirmed: true,
    mode: 'private',
    opted_out: false,
    code_pending: true,
    pending_phone: '+15550122',
    private_preview: 'Mannie: a reminder is due. Open the app to see it.',
    words: ['patel', 7],
  };
  const { fetcher, calls } = recordingFetch(() => Response.json({ data: wire }));
  const texts = createDeliveriesApi(fetcher).reach.texts;
  assert.deepEqual(await texts.status(), {
    phone: '+15550111',
    confirmed: true,
    mode: 'private',
    optedOut: false,
    codePending: true,
    pendingPhone: '+15550122',
    privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
    words: ['patel'],
  });
  await texts.sendCode('+15550111');
  await texts.confirm('123456');
  await texts.setMode('full');
  await texts.addWord('Lopez');
  await texts.removeWord('lopez');
  await texts.remove();
  assert.deepEqual(
    calls.map(call => [call.method, new URL(call.url).pathname, call.body]),
    [
      ['GET', '/api/v1/user/reach/texts', undefined],
      ['POST', '/api/v1/user/reach/texts/code', { phone: '+15550111' }],
      ['POST', '/api/v1/user/reach/texts/confirm', { code: '123456' }],
      ['PUT', '/api/v1/user/reach/texts', { mode: 'full' }],
      ['POST', '/api/v1/user/reach/texts/words', { word: 'Lopez' }],
      ['DELETE', '/api/v1/user/reach/texts/words/lopez', {}],
      ['DELETE', '/api/v1/user/reach/texts', {}],
    ],
  );
});

test('a wrong code reads as the server’s own plain sentence', async () => {
  const api = createDeliveriesApi(async () =>
    Response.json({ error: { message: 'That code is not right. You have 4 tries left.' } }, { status: 400 }),
  );
  await assert.rejects(api.reach.texts.confirm('000000'), /You have 4 tries left/);
});
