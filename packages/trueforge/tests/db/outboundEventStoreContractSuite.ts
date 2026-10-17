/**
 * Backend-agnostic behavioural contract for IOutboundEventStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { OutboundEventInput } from '@truefoundry/trueforge-core/core';

import type { IOutboundEventStore } from '../../src/db/outboundEventStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function event(overrides: Partial<OutboundEventInput> = {}): OutboundEventInput {
  return {
    tenant_id: 't1',
    kind: 'model_request',
    host: 'models.example.test',
    model: 'stub-model',
    tool_name: null,
    request_bytes: 1200,
    recipient_count: null,
    subject: null,
    conversation_id: 'c1',
    ...overrides,
  };
}

export function runOutboundEventStoreContractSuite(createStore: (now: () => Date) => IOutboundEventStore): void {
  const at = (iso: string) => () => new Date(iso);

  it('round-trips every field of every kind', async () => {
    const inputs: OutboundEventInput[] = [
      event(),
      event({
        kind: 'email_sent',
        host: 'mail.example.test',
        model: null,
        tool_name: 'send_email',
        recipient_count: 2,
        subject: 'Hello',
      }),
      event({ kind: 'web_search', host: 'search.example.test', model: null, tool_name: 'lookup' }),
      event({ kind: 'map_lookup', host: 'maps.example.test', model: null, request_bytes: null, conversation_id: null }),
      event({ kind: 'connector_call', host: 'svc.example.test', model: null, tool_name: 'list_things' }),
    ];
    for (const [index, input] of inputs.entries()) {
      await createStore(at(`2026-10-17T10:00:0${String(index)}.000Z`)).record(input);
    }

    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-17T00:00:00.000Z'),
      limit: 50,
    });

    expect(rows).toHaveLength(5);
    expect(rows.map(row => ({ ...row, id: undefined, created_at: undefined }))).toEqual(
      [...inputs].reverse().map(input => ({ ...input, tenant_id: undefined, id: undefined, created_at: undefined })),
    );
    for (const row of rows) {
      expect(row.id).toEqual(expect.any(String));
      expect(row.created_at).toMatch(ISO_UTC);
    }
  });

  it('lists newest first', async () => {
    await createStore(at('2026-10-17T10:00:00.000Z')).record(event({ host: 'first.example.test' }));
    await createStore(at('2026-10-17T10:05:00.000Z')).record(event({ host: 'second.example.test' }));
    await createStore(at('2026-10-17T10:02:00.000Z')).record(event({ host: 'middle.example.test' }));

    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-17T00:00:00.000Z'),
      limit: 50,
    });

    expect(rows.map(row => row.host)).toEqual(['second.example.test', 'middle.example.test', 'first.example.test']);
  });

  it('only lists events inside the window, boundary included', async () => {
    await createStore(at('2026-10-16T09:59:59.999Z')).record(event({ host: 'too-old.example.test' }));
    await createStore(at('2026-10-16T10:00:00.000Z')).record(event({ host: 'on-the-line.example.test' }));
    await createStore(at('2026-10-17T09:00:00.000Z')).record(event({ host: 'recent.example.test' }));

    const rows = await createStore(at('2026-10-17T10:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-16T10:00:00.000Z'),
      limit: 50,
    });

    expect(rows.map(row => row.host)).toEqual(['recent.example.test', 'on-the-line.example.test']);
  });

  it('is scoped to the tenant', async () => {
    await createStore(at('2026-10-17T10:00:00.000Z')).record(event({ tenant_id: 't1', host: 'mine.example.test' }));
    await createStore(at('2026-10-17T10:00:00.000Z')).record(event({ tenant_id: 't2', host: 'theirs.example.test' }));

    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-17T00:00:00.000Z'),
      limit: 50,
    });

    expect(rows.map(row => row.host)).toEqual(['mine.example.test']);
  });

  it('honours the limit, keeping the newest', async () => {
    for (let minute = 0; minute < 5; minute += 1) {
      await createStore(at(`2026-10-17T10:0${String(minute)}:00.000Z`)).record(
        event({ host: `h${String(minute)}.example.test` }),
      );
    }

    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-17T00:00:00.000Z'),
      limit: 2,
    });

    expect(rows.map(row => row.host)).toEqual(['h4.example.test', 'h3.example.test']);
  });

  it('returns an empty list when nothing was recorded', async () => {
    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-16T11:00:00.000Z'),
      limit: 50,
    });

    expect(rows).toEqual([]);
  });

  it('deleteBefore removes only older events and reports how many', async () => {
    await createStore(at('2026-09-01T10:00:00.000Z')).record(event({ host: 'old1.example.test' }));
    await createStore(at('2026-09-02T10:00:00.000Z')).record(event({ host: 'old2.example.test' }));
    await createStore(at('2026-10-17T10:00:00.000Z')).record(event({ host: 'new.example.test' }));

    const removed = await createStore(at('2026-10-17T11:00:00.000Z')).deleteBefore({
      before: new Date('2026-10-01T00:00:00.000Z'),
    });
    const rows = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-01-01T00:00:00.000Z'),
      limit: 50,
    });

    expect(removed).toBe(2);
    expect(rows.map(row => row.host)).toEqual(['new.example.test']);
  });

  it('stores no column that could hold request text', async () => {
    await createStore(at('2026-10-17T10:00:00.000Z')).record(event());
    const [row] = await createStore(at('2026-10-17T11:00:00.000Z')).listSince({
      tenant_id: 't1',
      since: new Date('2026-10-17T00:00:00.000Z'),
      limit: 1,
    });

    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'conversation_id',
        'created_at',
        'host',
        'id',
        'kind',
        'model',
        'recipient_count',
        'request_bytes',
        'subject',
        'tool_name',
      ].sort(),
    );
  });
}
