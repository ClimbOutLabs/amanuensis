import { createOutboundEventsRouter, OUTBOUND_WINDOW_MS } from '../../../src/apis/privacy';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteOutboundEventStore } from '../../../src/db/sqlite/outbound-event-store/SqliteOutboundEventStore';
import { ListOutboundEventsResponseSchema } from '../../../src/schemas/privacy';

const NOW = new Date('2026-10-17T12:00:00.000Z');

const context: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'owner', type: 'user', display_name: 'owner' },
  roles: ['admin'],
  user_credential: null,
};

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const at = (iso: string) => new SqliteOutboundEventStore(db, () => new Date(iso));
  const router = createOutboundEventsRouter({
    outboundEventStore: new SqliteOutboundEventStore(db, () => NOW),
    resolveRequestContext: () => context,
    now: () => NOW,
  });
  return { router, at };
}

const base = {
  tenant_id: 'default',
  model: null,
  tool_name: null,
  request_bytes: null,
  recipient_count: null,
  subject: null,
  conversation_id: null,
} as const;

describe('outbound events route', () => {
  it('reports an empty window plainly', async () => {
    const { router } = await setup();
    const response = await router.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      window_start: new Date(NOW.getTime() - OUTBOUND_WINDOW_MS).toISOString(),
      truncated: false,
    });
  });

  it('includes events from the last 24 hours and leaves out older ones', async () => {
    const { router, at } = await setup();
    await at('2026-10-16T11:59:59.000Z').record({ ...base, kind: 'web_search', host: 'old.example.test' });
    await at('2026-10-16T12:00:00.000Z').record({ ...base, kind: 'web_search', host: 'edge.example.test' });
    await at('2026-10-17T11:59:00.000Z').record({ ...base, kind: 'web_search', host: 'new.example.test' });

    const body = ListOutboundEventsResponseSchema.parse(await (await router.request('/')).json());

    expect(body.data.map(event => event.host)).toEqual(['new.example.test', 'edge.example.test']);
  });

  it('serves each kind with the fields recorded for it', async () => {
    const { router, at } = await setup();
    await at('2026-10-17T10:00:00.000Z').record({
      ...base,
      kind: 'email_sent',
      host: 'mail.example.test',
      tool_name: 'send_email',
      request_bytes: 321,
      recipient_count: 3,
      subject: 'Quarterly numbers',
    });
    await at('2026-10-17T10:01:00.000Z').record({
      ...base,
      kind: 'map_lookup',
      host: 'maps.example.test',
    });

    const body = ListOutboundEventsResponseSchema.parse(await (await router.request('/')).json());

    expect(body.data).toEqual([
      expect.objectContaining({ kind: 'map_lookup', host: 'maps.example.test', request_bytes: null }),
      expect.objectContaining({
        kind: 'email_sent',
        host: 'mail.example.test',
        tool_name: 'send_email',
        request_bytes: 321,
        recipient_count: 3,
        subject: 'Quarterly numbers',
      }),
    ]);
  });

  it('says when the window holds more than the page returned', async () => {
    const { router, at } = await setup();
    for (let minute = 0; minute < 3; minute += 1) {
      await at(`2026-10-17T10:0${String(minute)}:00.000Z`).record({
        ...base,
        kind: 'connector_call',
        host: `h${String(minute)}.example.test`,
      });
    }

    const page = ListOutboundEventsResponseSchema.parse(await (await router.request('/?limit=2')).json());
    const all = ListOutboundEventsResponseSchema.parse(await (await router.request('/?limit=3')).json());

    expect(page.data.map(event => event.host)).toEqual(['h2.example.test', 'h1.example.test']);
    expect(page.truncated).toBe(true);
    expect(all.data).toHaveLength(3);
    expect(all.truncated).toBe(false);
  });

  it('refuses a limit outside what it serves', async () => {
    const { router } = await setup();

    expect((await router.request('/?limit=0')).status).toBe(400);
    expect((await router.request('/?limit=501')).status).toBe(400);
  });
});
