/**
 * Backend-agnostic behavioural contract for IDeliveryStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IDeliveryStore } from '../../src/db/deliveryStore';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };

function reminder(owner: { tenant_id: string; created_by: string }, text = 'Call the dentist', at?: Date) {
  return {
    ...owner,
    kind: 'reminder' as const,
    level: 'nudge' as const,
    text,
    reason: 'You asked for this reminder.',
    link: { type: 'chat' as const, session_id: 's1' },
    ...(at === undefined ? {} : { created_at: at }),
  };
}

export function runDeliveryStoreContractSuite(getStore: () => IDeliveryStore): void {
  it('creates an unread delivery that reads back whole', async () => {
    const store = getStore();
    const made = await store.create(reminder(ALICE));
    expect(made).toMatchObject({
      kind: 'reminder',
      level: 'nudge',
      text: 'Call the dentist',
      reason: 'You asked for this reminder.',
      link: { type: 'chat', session_id: 's1' },
      seen_at: null,
      attempts: [],
    });
    await expect(store.get({ ...ALICE, id: made.id })).resolves.toEqual(made);
  });

  it('refuses an approval_waiting delivery that does not link to an approval', async () => {
    const store = getStore();
    await expect(
      store.create({ ...ALICE, kind: 'approval_waiting', level: 'nudge', text: 'x', reason: 'y', link: null }),
    ).rejects.toThrow();
    const made = await store.create({
      ...ALICE,
      kind: 'approval_waiting',
      level: 'nudge',
      text: 'Send the email?',
      reason: 'An action is waiting for your ok.',
      link: { type: 'approval', session_id: 's1', approval_id: 'a1' },
    });
    expect(made.kind).toBe('approval_waiting');
  });

  it('lists newest first and pages with a token', async () => {
    const store = getStore();
    const base = Date.now() - 60_000;
    for (let i = 0; i < 5; i += 1) {
      await store.create(reminder(ALICE, `item ${String(i)}`, new Date(base + i * 1000)));
    }
    const first = await store.list({ ...ALICE, limit: 2 });
    expect(first.deliveries.map(d => d.text)).toEqual(['item 4', 'item 3']);
    expect(first.next_page_token).toBeDefined();
    const second = await store.list({ ...ALICE, limit: 2, page_token: first.next_page_token });
    expect(second.deliveries.map(d => d.text)).toEqual(['item 2', 'item 1']);
    const third = await store.list({ ...ALICE, limit: 2, page_token: second.next_page_token });
    expect(third.deliveries.map(d => d.text)).toEqual(['item 0']);
    expect(third.next_page_token).toBeUndefined();
  });

  it('keeps one person’s deliveries away from another person and another tenant', async () => {
    const store = getStore();
    const mine = await store.create(reminder(ALICE, 'mine'));
    await store.create(reminder(BOB, 'bobs'));
    await store.create(reminder(OTHER_TENANT, 'elsewhere'));

    expect((await store.list({ ...ALICE, limit: 10 })).deliveries.map(d => d.text)).toEqual(['mine']);
    await expect(store.countUnread(ALICE)).resolves.toBe(1);
    await expect(store.get({ ...BOB, id: mine.id })).resolves.toBeUndefined();
    await expect(store.markSeen({ ...BOB, ids: [mine.id] })).resolves.toBe(0);
    await expect(store.recordAttempt({ ...BOB, delivery_id: mine.id, attempt: attempt() })).resolves.toBe(false);
    await expect(store.countUnread(ALICE)).resolves.toBe(1);
    await expect(store.listForExport(BOB)).resolves.toHaveLength(1);
  });

  it('marks seen once, keeps the first time, and counts unread', async () => {
    const store = getStore();
    const a = await store.create(reminder(ALICE, 'a'));
    const b = await store.create(reminder(ALICE, 'b'));
    await expect(store.countUnread(ALICE)).resolves.toBe(2);

    const first = new Date(Date.now() - 5000);
    await expect(store.markSeen({ ...ALICE, ids: [a.id], now: first })).resolves.toBe(1);
    await expect(store.markSeen({ ...ALICE, ids: [a.id, 'missing'] })).resolves.toBe(0);
    await expect(store.countUnread(ALICE)).resolves.toBe(1);
    expect((await store.get({ ...ALICE, id: a.id }))?.seen_at).toBe(first.toISOString());
    expect((await store.get({ ...ALICE, id: b.id }))?.seen_at).toBeNull();
  });

  it('records channel attempts in order and returns them with the delivery', async () => {
    const store = getStore();
    const made = await store.create(reminder(ALICE));
    const t0 = new Date(Date.now() - 2000).toISOString();
    const t1 = new Date(Date.now() - 1000).toISOString();
    await store.recordAttempt({
      ...ALICE,
      delivery_id: made.id,
      attempt: { channel: 'in_app', outcome: 'sent', detail: null, target: null, attempted_at: t0 },
    });
    await store.recordAttempt({
      ...ALICE,
      delivery_id: made.id,
      attempt: { channel: 'web_push', outcome: 'gone', detail: 'The device is gone.', target: 'p1', attempted_at: t1 },
    });
    const read = await store.get({ ...ALICE, id: made.id });
    expect(read?.attempts.map(a => [a.channel, a.outcome])).toEqual([
      ['in_app', 'sent'],
      ['web_push', 'gone'],
    ]);
    const page = await store.list({ ...ALICE, limit: 5 });
    expect(page.deliveries[0]?.attempts).toHaveLength(2);
  });

  it('exports and imports deliveries with their attempts, skipping ones already there', async () => {
    const store = getStore();
    const made = await store.create(reminder(ALICE));
    await store.recordAttempt({ ...ALICE, delivery_id: made.id, attempt: attempt() });
    const exported = await store.listForExport(ALICE);
    expect(exported).toHaveLength(1);

    // An id already in use is left as it is, so an import run twice adds nothing the second time.
    await expect(store.importDeliveries({ ...ALICE, deliveries: exported })).resolves.toBe(0);

    const fromElsewhere = exported.map(d => ({ ...d, id: `${d.id}-old` }));
    await expect(store.importDeliveries({ ...BOB, deliveries: fromElsewhere })).resolves.toBe(1);
    await expect(store.importDeliveries({ ...BOB, deliveries: fromElsewhere })).resolves.toBe(0);
    const imported = await store.list({ ...BOB, limit: 10 });
    expect(imported.deliveries).toHaveLength(1);
    expect(imported.deliveries[0]?.attempts).toHaveLength(1);
    await expect(store.list({ ...ALICE, limit: 10 })).resolves.toMatchObject({ deliveries: [{ id: made.id }] });
  });
}

function attempt() {
  return {
    channel: 'in_app' as const,
    outcome: 'sent' as const,
    detail: null,
    target: null,
    attempted_at: new Date().toISOString(),
  };
}
