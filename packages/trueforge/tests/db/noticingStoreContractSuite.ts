/**
 * Backend-agnostic behavioural contract for INoticingStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { INoticingStore } from '../../src/db/noticingStore';
import type { NoticingEvent } from '../../src/schemas/reach';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const AT = new Date('2026-11-05T10:00:00.000Z');
const LATER = new Date('2026-11-05T10:20:00.000Z');
/** A claim taken before this is treated as abandoned. */
const STALE_BEFORE = new Date('2026-11-05T10:10:00.000Z');

function event(id: string, overrides: Partial<NoticingEvent> = {}): NoticingEvent {
  return {
    id,
    kind: 'calendar_clash',
    evidence: 'own',
    summary: 'Two things overlap.',
    facts: 'Event one and event two.',
    matched: 'Two events overlap.',
    link: null,
    mail_ref: null,
    occurred_at: '2026-11-05T10:00:00.000Z',
    due_at: null,
    ...overrides,
  };
}

const CLASHES = ['calendar_clash'] as const;

export function runNoticingStoreContractSuite(getStore: () => INoticingStore): void {
  it('records each event once per person and leaves one already recorded as it was', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e1')], status: 'pending', now: AT });
    await store.recordAll({ ...ALICE, events: [event('e1'), event('e2')], status: 'tracking', now: LATER });
    await store.recordAll({ ...BOB, events: [event('e1')], status: 'pending', now: AT });
    const pending = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(pending.map(item => item.event.id)).toEqual(['e1']);
    const bobs = await store.listPending({ ...BOB, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(bobs.map(item => item.event.id)).toEqual(['e1']);
  });

  it('lists pending events of the asked kinds, oldest first, for one person', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e2')], status: 'pending', now: LATER });
    await store.recordAll({
      ...ALICE,
      events: [event('e1'), event('m1', { kind: 'mail_always' })],
      status: 'pending',
      now: AT,
    });
    await store.recordAll({ ...BOB, events: [event('b1')], status: 'pending', now: AT });

    const pending = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(pending.map(item => item.event.id)).toEqual(['e1', 'e2']);
  });

  it('lets one claim win, and only the holder start delivering or finish', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e1')], status: 'pending', now: AT });

    const claim = { ...ALICE, event_id: 'e1', stale_before: AT };
    await expect(store.claim({ ...claim, claim_id: 'first', now: AT })).resolves.toEqual({ verdict: null });
    await expect(store.claim({ ...claim, claim_id: 'second', now: AT })).resolves.toBeUndefined();
    // A held claim hides the event from the list until it goes stale.
    await expect(store.listPending({ ...ALICE, kinds: CLASHES, stale_before: AT, limit: 10 })).resolves.toEqual([]);

    // The first holder never came back. Once its claim is older than the stale mark, another pass takes over.
    const listed = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(listed.map(item => item.event.id)).toEqual(['e1']);
    await expect(
      store.claim({ ...ALICE, event_id: 'e1', claim_id: 'third', now: LATER, stale_before: STALE_BEFORE }),
    ).resolves.toEqual({ verdict: null });
    // The first holder, back late, can no longer start delivering.
    await expect(store.startDelivering({ ...ALICE, event_id: 'e1', claim_id: 'first', now: LATER })).resolves.toBe(
      false,
    );
    await expect(store.startDelivering({ ...ALICE, event_id: 'e1', claim_id: 'third', now: LATER })).resolves.toBe(
      true,
    );
    await store.finish({ ...ALICE, event_id: 'e1', claim_id: 'first', delivery_id: 'd0' });
    await store.finish({ ...ALICE, event_id: 'e1', claim_id: 'third', delivery_id: 'd1' });
    await expect(
      store.listPending({ ...ALICE, kinds: CLASHES, stale_before: new Date('2030-01-01'), limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('hands an event left halfway through delivery to the next pass, with the answer the model gave', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e1')], status: 'pending', now: AT });
    await store.claim({ ...ALICE, event_id: 'e1', claim_id: 'first', now: AT, stale_before: AT });
    const verdict = { level: 'nudge' as const, reason: 'It overlaps.', message: 'Two things overlap.' };
    await store.saveVerdict({ ...ALICE, event_id: 'e1', claim_id: 'first', verdict });
    await store.startDelivering({ ...ALICE, event_id: 'e1', claim_id: 'first', now: AT });

    // The pass stopped before it finished. Its claim goes stale and another pass takes the event over.
    await expect(store.listPending({ ...ALICE, kinds: CLASHES, stale_before: AT, limit: 10 })).resolves.toEqual([]);
    const listed = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(listed.map(item => item.event.id)).toEqual(['e1']);
    await expect(
      store.claim({ ...ALICE, event_id: 'e1', claim_id: 'second', now: LATER, stale_before: STALE_BEFORE }),
    ).resolves.toEqual({ verdict });
  });

  it('counts every claim as a try, takes back one that only waited, and gives up after five', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e1'), event('e2')], status: 'pending', now: AT });
    const claim = { ...ALICE, now: AT, stale_before: AT };

    // Waiting for another pass is not a failure, so it never counts toward giving up.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await store.claim({ ...claim, event_id: 'e1', claim_id: `busy${String(attempt)}` });
      await expect(
        store.release({ ...ALICE, event_id: 'e1', claim_id: `busy${String(attempt)}`, failed: false }),
      ).resolves.toBe('pending');
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(store.claim({ ...claim, event_id: 'e1', claim_id: `c${String(attempt)}` })).resolves.toBeDefined();
      await expect(
        store.release({ ...ALICE, event_id: 'e1', claim_id: `c${String(attempt)}`, failed: true }),
      ).resolves.toBe('pending');
    }
    await expect(store.claim({ ...claim, event_id: 'e1', claim_id: 'c5' })).resolves.toBeDefined();
    await expect(store.release({ ...ALICE, event_id: 'e1', claim_id: 'c5', failed: true })).resolves.toBe('failed');
    await expect(store.claim({ ...claim, event_id: 'e1', claim_id: 'c6' })).resolves.toBeUndefined();

    // A pass that stopped without handing the event back counts as a try too.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const at = new Date(AT.getTime() + attempt * 3_600_000);
      await expect(
        store.claim({ ...ALICE, event_id: 'e2', claim_id: `s${String(attempt)}`, now: at, stale_before: at }),
      ).resolves.toBeDefined();
    }
    const end = new Date(AT.getTime() + 6 * 3_600_000);
    await expect(
      store.claim({ ...ALICE, event_id: 'e2', claim_id: 's6', now: end, stale_before: end }),
    ).resolves.toBeUndefined();
    await expect(store.listPending({ ...ALICE, kinds: CLASHES, stale_before: end, limit: 10 })).resolves.toEqual([]);
  });

  it('drops old waiting events of a kind for everyone, and leaves newer ones and other kinds', async () => {
    const store = getStore();
    const approval = (id: string) => event(id, { kind: 'approval_waiting' });
    await store.recordAll({ ...ALICE, events: [approval('a1'), event('e1')], status: 'pending', now: AT });
    await store.recordAll({ ...BOB, events: [approval('b1')], status: 'pending', now: AT });
    await store.recordAll({ ...BOB, events: [approval('b2')], status: 'pending', now: LATER });
    await store.dropStale({ kinds: ['approval_waiting'], created_before: STALE_BEFORE });
    const kinds = ['approval_waiting', 'calendar_clash'] as const;
    const alice = await store.listPending({ ...ALICE, kinds, stale_before: STALE_BEFORE, limit: 10 });
    expect(alice.map(item => item.event.id)).toEqual(['e1']);
    const bob = await store.listPending({ ...BOB, kinds, stale_before: STALE_BEFORE, limit: 10 });
    expect(bob.map(item => item.event.id)).toEqual(['b2']);
  });

  it('tracks events by due date, moves one to pending once, and drops them', async () => {
    const store = getStore();
    const later = event('b2', { kind: 'bill_due', due_at: '2026-11-10T00:00:00.000Z' });
    const sooner = event('b1', { kind: 'bill_due', due_at: '2026-11-07T00:00:00.000Z' });
    const far = event('b3', { kind: 'bill_due', due_at: '2026-12-30T00:00:00.000Z' });
    for (const item of [later, sooner, far]) {
      await store.recordAll({ ...ALICE, events: [item], status: 'tracking', now: AT });
    }
    await store.recordAll({
      ...BOB,
      events: [event('b4', { kind: 'bill_due', due_at: '2026-11-06T00:00:00.000Z' })],
      status: 'tracking',
      now: AT,
    });

    const before = new Date('2026-11-11T00:00:00.000Z');
    const due = await store.listTracking({ ...ALICE, due_before: before, limit: 10 });
    expect(due.map(item => item.id)).toEqual(['b1', 'b2']);

    await store.promote({ ...ALICE, event_id: 'b1' });
    await store.promote({ ...ALICE, event_id: 'b1' });
    const pending = await store.listPending({ ...ALICE, kinds: ['bill_due'], stale_before: AT, limit: 10 });
    expect(pending.map(item => item.event.id)).toEqual(['b1']);

    await store.drop({ ...ALICE, event_id: 'b2' });
    await expect(store.listTracking({ ...ALICE, due_before: before, limit: 10 })).resolves.toEqual([]);
    await store.promote({ ...ALICE, event_id: 'b2' });
    await expect(
      store.listPending({ ...ALICE, kinds: ['bill_due'], stale_before: AT, limit: 10 }),
    ).resolves.toHaveLength(1);
  });

  it('gives each event its own delivery id when it is first written, and keeps it', async () => {
    const store = getStore();
    await store.recordAll({ ...ALICE, events: [event('e1'), event('e2')], status: 'pending', now: AT });
    await store.recordAll({ ...ALICE, events: [event('e1')], status: 'pending', now: LATER });
    await store.recordAll({ ...BOB, events: [event('e1')], status: 'pending', now: AT });
    const alices = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    const [bobs] = await store.listPending({ ...BOB, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    const first = alices.find(item => item.event.id === 'e1');
    expect(first?.status).toBe('pending');
    expect(new Set([...alices.map(item => item.delivery_id), bobs?.delivery_id]).size).toBe(3);
    await store.claim({ ...ALICE, event_id: 'e1', claim_id: 'c1', now: AT, stale_before: AT });
    await store.startDelivering({ ...ALICE, event_id: 'e1', claim_id: 'c1', now: AT });
    const again = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(again.find(item => item.event.id === 'e1')).toMatchObject({
      status: 'delivering',
      delivery_id: first?.delivery_id,
    });
  });

  it('leaves an event being delivered to settle, which closes it only once its claim went stale', async () => {
    const store = getStore();
    const approval = (id: string) => event(id, { kind: 'approval_waiting' });
    await store.recordAll({ ...ALICE, events: [approval('a1'), approval('a2')], status: 'pending', now: AT });
    for (const id of ['a1', 'a2']) {
      await store.claim({ ...ALICE, event_id: id, claim_id: id, now: AT, stale_before: AT });
      await store.startDelivering({ ...ALICE, event_id: id, claim_id: id, now: AT });
    }
    await store.dropStale({ kinds: ['approval_waiting'], created_before: LATER });
    await store.drop({ ...ALICE, event_id: 'a1' });
    const kinds = ['approval_waiting'] as const;
    const left = await store.listPending({ ...ALICE, kinds, stale_before: STALE_BEFORE, limit: 10 });
    // Both were written at the same time, so their order is not part of the contract.
    expect(left.map(item => [item.event.id, item.status]).sort()).toEqual([
      ['a1', 'delivering'],
      ['a2', 'delivering'],
    ]);

    // A live claim is never settled under the pass that holds it.
    await store.settle({ ...ALICE, event_id: 'a1', stale_before: AT, status: 'dropped' });
    await expect(store.listPending({ ...ALICE, kinds, stale_before: STALE_BEFORE, limit: 10 })).resolves.toHaveLength(
      2,
    );

    await store.settle({ ...ALICE, event_id: 'a1', stale_before: STALE_BEFORE, status: 'raised' });
    await store.settle({ ...BOB, event_id: 'a2', stale_before: STALE_BEFORE, status: 'dropped' });
    const after = await store.listPending({ ...ALICE, kinds, stale_before: STALE_BEFORE, limit: 10 });
    expect(after.map(item => item.event.id)).toEqual(['a2']);
    await store.settle({ ...ALICE, event_id: 'a2', stale_before: STALE_BEFORE, status: 'dropped' });
    await expect(store.listPending({ ...ALICE, kinds, stale_before: STALE_BEFORE, limit: 10 })).resolves.toEqual([]);
  });

  it('lets one holder at a time make reach decisions for a person', async () => {
    const store = getStore();
    const until = new Date(AT.getTime() + 60_000);
    await expect(store.acquireReachLease({ ...ALICE, holder: 'one', now: AT, until })).resolves.toBe(true);
    await expect(store.acquireReachLease({ ...ALICE, holder: 'two', now: AT, until })).resolves.toBe(false);
    await expect(store.acquireReachLease({ ...BOB, holder: 'two', now: AT, until })).resolves.toBe(true);

    // Releasing someone else's lease does nothing.
    await store.releaseReachLease({ ...ALICE, holder: 'two' });
    await expect(store.acquireReachLease({ ...ALICE, holder: 'two', now: AT, until })).resolves.toBe(false);

    await store.releaseReachLease({ ...ALICE, holder: 'one' });
    await expect(store.acquireReachLease({ ...ALICE, holder: 'two', now: AT, until })).resolves.toBe(true);

    // A holder that never released is passed over once its time is up.
    const afterExpiry = new Date(until.getTime() + 1);
    await expect(store.acquireReachLease({ ...ALICE, holder: 'three', now: afterExpiry, until: LATER })).resolves.toBe(
      true,
    );
  });

  it('keeps a checkpoint per watcher and person', async () => {
    const store = getStore();
    const clear = { failure: undefined, stuck: undefined, cursor: undefined, source: undefined };
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toBeUndefined();
    await store.setCheckpoint({
      ...ALICE,
      watcher: 'mail',
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      ...clear,
    });
    await store.setCheckpoint({
      ...ALICE,
      watcher: 'mail',
      checked_at: new Date('2026-11-05T10:10:00.000Z'),
      ...clear,
    });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual({
      checked_at: new Date('2026-11-05T10:10:00.000Z'),
      ...clear,
    });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'calendar' })).resolves.toBeUndefined();
    await expect(store.getCheckpoint({ ...BOB, watcher: 'mail' })).resolves.toBeUndefined();
  });

  it('keeps whether the mail source reports sender confirmation with its checkpoint', async () => {
    const store = getStore();
    const base = {
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      failure: undefined,
      stuck: undefined,
      cursor: undefined,
      source: 'email_connector' as const,
    };
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', ...base, sender_confirmation: false });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual({
      ...base,
      sender_confirmation: false,
    });
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', ...base, sender_confirmation: true });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual({
      ...base,
      sender_confirmation: true,
    });
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', ...base, sender_confirmation: undefined });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual({
      ...base,
      sender_confirmation: undefined,
    });
  });

  it('lists everyone with a checkpoint for a watcher', async () => {
    const store = getStore();
    const clear = { failure: undefined, stuck: undefined, cursor: undefined, source: undefined };
    await store.setCheckpoint({
      ...ALICE,
      watcher: 'mail',
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      ...clear,
    });
    await store.setCheckpoint({
      ...BOB,
      watcher: 'calendar',
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      ...clear,
    });
    await expect(store.listCheckpointOwners({ watcher: 'mail' })).resolves.toEqual([ALICE]);
    await expect(store.listCheckpointOwners({ watcher: 'calendar' })).resolves.toEqual([BOB]);
  });

  it('keeps a watcher’s trouble with its checkpoint until a pass that works clears it', async () => {
    const store = getStore();
    const trouble = {
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      failure: { kind: 'too_slow' as const, since: new Date('2026-11-05T09:00:00.000Z') },
      stuck: { message_id: 'm7', passes: 2, since: new Date('2026-11-05T09:00:00.000Z') },
      cursor: { uidvalidity: 4, last_uid: 912 },
      source: 'email_connector' as const,
    };
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', ...trouble });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual(trouble);
    await expect(store.getCheckpoint({ ...BOB, watcher: 'mail' })).resolves.toBeUndefined();
    await store.setCheckpoint({
      ...ALICE,
      watcher: 'mail',
      checked_at: new Date('2026-11-05T10:10:00.000Z'),
      failure: undefined,
      stuck: undefined,
      source: 'google',
    });
    const cleared = await store.getCheckpoint({ ...ALICE, watcher: 'mail' });
    expect(cleared).toEqual({
      checked_at: new Date('2026-11-05T10:10:00.000Z'),
      failure: undefined,
      stuck: undefined,
      source: 'google',
    });
    expect(cleared?.cursor).toBeUndefined();
  });

  it('keeps the part of the mailbox still to be dated with the cursor, so the next pass holds it to the same time', async () => {
    const store = getStore();
    const dated = {
      checked_at: new Date('2026-11-05T10:00:00.000Z'),
      failure: undefined,
      stuck: undefined,
      cursor: { uidvalidity: 4, last_uid: 400, dated: { to_uid: 912, since: new Date('2026-11-05T09:50:00.000Z') } },
      source: 'email_connector' as const,
    };
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', ...dated });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual(dated);
  });
}
