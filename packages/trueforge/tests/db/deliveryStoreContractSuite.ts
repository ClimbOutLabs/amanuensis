/**
 * Backend-agnostic behavioural contract for IDeliveryStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import { DELIVERY_EXPORT_LIMIT, type IDeliveryStore } from '../../src/db/deliveryStore';

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

  it('makes a delivery with a given id once, and hands back the first one after that', async () => {
    const store = getStore();
    const first = await store.createOnce({ ...reminder(ALICE), id: 'fixed-1' });
    expect(first.created).toBe(true);
    expect(first.delivery.id).toBe('fixed-1');
    const again = await store.createOnce({ ...reminder(ALICE, 'Different words'), id: 'fixed-1' });
    expect(again).toEqual({ delivery: first.delivery, created: false });
    expect((await store.list({ ...ALICE, limit: 10 })).deliveries).toHaveLength(1);
    // Someone else's delivery holds the id, so Bob gets nothing and Alice's is left alone.
    await expect(store.createOnce({ ...reminder(BOB), id: 'fixed-1' })).rejects.toThrow('belongs to someone else');
    await expect(store.get({ ...BOB, id: 'fixed-1' })).resolves.toBeUndefined();
    await expect(store.get({ ...ALICE, id: 'fixed-1' })).resolves.toEqual(first.delivery);
  });

  it('counts one person’s deliveries since a time by kind and level, and finds the last at a level', async () => {
    const store = getStore();
    const at = (time: string) => new Date(`2026-11-05T${time}:00.000Z`);
    await store.create({ ...reminder(ALICE, 'old', new Date('2026-11-04T23:00:00.000Z')), kind: 'nudge' });
    await store.create({ ...reminder(ALICE, 'one', at('09:00')), kind: 'nudge' });
    await store.create({ ...reminder(ALICE, 'two', at('09:30')), kind: 'nudge', level: 'call' });
    await store.create({ ...reminder(ALICE, 'quiet', at('10:00')), kind: 'note', level: 'note' });
    await store.create(reminder(ALICE, 'reminder', at('10:30')));
    await store.create({
      ...reminder(ALICE, 'waiting', at('11:00')),
      kind: 'approval_waiting',
      link: { type: 'approval', session_id: 's1', approval_id: 'a1' },
    });
    await store.create({ ...reminder(BOB, 'bob', at('09:00')), kind: 'nudge' });

    const since = at('00:00');
    await expect(
      store.countSince({ ...ALICE, since, kinds: ['nudge', 'approval_waiting'], levels: ['nudge'] }),
    ).resolves.toBe(2);
    await expect(store.countSince({ ...ALICE, since, kinds: ['reminder'], levels: ['nudge'] })).resolves.toBe(1);
    await expect(store.countSince({ ...BOB, since, kinds: ['nudge'], levels: ['nudge'] })).resolves.toBe(1);
    await expect(store.lastCreatedAt({ ...ALICE, levels: ['call'] })).resolves.toEqual(at('09:30'));
    await expect(store.lastCreatedAt({ ...BOB, levels: ['call'] })).resolves.toBeUndefined();
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

  it('lists one person’s unread deliveries of the kinds asked for, newest first', async () => {
    const store = getStore();
    const approval = (approval_id: string, minutesAgo: number) =>
      store.create({
        ...ALICE,
        kind: 'approval_waiting',
        level: 'nudge',
        text: 'Send the email?',
        reason: 'An action is waiting for your ok.',
        link: { type: 'approval', session_id: 's1', approval_id },
        created_at: new Date(Date.now() - minutesAgo * 60_000),
      });
    const older = await approval('a1', 3);
    const seen = await approval('a2', 2);
    await store.markSeen({ ...ALICE, ids: [seen.id] });
    await store.create(reminder(ALICE));
    await store.create({
      ...BOB,
      kind: 'approval_waiting',
      level: 'nudge',
      text: 'x',
      reason: 'y',
      link: { type: 'approval', session_id: 's2', approval_id: 'b1' },
    });
    const newer = await approval('a3', 1);

    const unread = await store.listUnread({ ...ALICE, kinds: ['approval_waiting'], limit: 10 });
    expect(unread.map(item => item.id)).toEqual([newer.id, older.id]);
    await expect(store.listUnread({ ...ALICE, kinds: ['approval_waiting'], limit: 1 })).resolves.toHaveLength(1);
    await expect(store.listUnread({ ...ALICE, kinds: [], limit: 10 })).resolves.toEqual([]);
  });

  it('marks all of one person’s unread seen and leaves everyone else’s', async () => {
    const store = getStore();
    for (let index = 0; index < 120; index += 1) {
      await store.create(reminder(ALICE, `item ${String(index)}`));
    }
    await store.create(reminder(BOB, 'bob'));
    await store.create(reminder(OTHER_TENANT, 'other'));

    await expect(store.markAllSeen(ALICE)).resolves.toBe(120);
    await expect(store.countUnread(ALICE)).resolves.toBe(0);
    await expect(store.countUnread(BOB)).resolves.toBe(1);
    await expect(store.countUnread(OTHER_TENANT)).resolves.toBe(1);
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

  it('imports a full export where every delivery went to many devices', async () => {
    const store = getStore();
    const made = await store.create(reminder(ALICE));
    const [template] = await store.listForExport(ALICE);
    if (template === undefined) {
      throw new Error('The template delivery did not read back.');
    }
    const attempts = Array.from({ length: 12 }, () => ({ ...attempt(), channel: 'web_push' as const }));
    const full = Array.from({ length: DELIVERY_EXPORT_LIMIT }, (_, index) => ({
      ...template,
      id: `${made.id}-${String(index).padStart(4, '0')}`,
      attempts,
    }));

    await expect(store.importDeliveries({ ...BOB, deliveries: full })).resolves.toBe(DELIVERY_EXPORT_LIMIT);
    await expect(store.countUnread(BOB)).resolves.toBe(DELIVERY_EXPORT_LIMIT);
    const page = await store.list({ ...BOB, limit: 1 });
    expect(page.deliveries[0]?.attempts).toHaveLength(12);
  }, 60_000);
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
