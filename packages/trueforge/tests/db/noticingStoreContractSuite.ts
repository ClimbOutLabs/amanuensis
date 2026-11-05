/**
 * Backend-agnostic behavioural contract for INoticingStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { INoticingStore, NoticingDecision } from '../../src/db/noticingStore';
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

function decision(overrides: Partial<NoticingDecision> = {}): NoticingDecision {
  return {
    model_level: 'call',
    decided_level: 'call',
    delivered_level: 'nudge',
    reason: 'It overlaps.',
    delivery_id: 'd1',
    ...overrides,
  };
}

const CLASHES = ['calendar_clash'] as const;

export function runNoticingStoreContractSuite(getStore: () => INoticingStore): void {
  it('records an event once and says seen after that, per person', async () => {
    const store = getStore();
    await expect(store.record({ ...ALICE, event: event('e1'), status: 'pending', now: AT })).resolves.toBe('new');
    await expect(store.record({ ...ALICE, event: event('e1'), status: 'pending', now: AT })).resolves.toBe('seen');
    await expect(store.record({ ...BOB, event: event('e1'), status: 'pending', now: AT })).resolves.toBe('new');
  });

  it('lists pending events of the asked kinds, oldest first, for one person', async () => {
    const store = getStore();
    await store.record({ ...ALICE, event: event('e2'), status: 'pending', now: LATER });
    await store.record({ ...ALICE, event: event('e1'), status: 'pending', now: AT });
    await store.record({ ...ALICE, event: event('m1', { kind: 'mail_always' }), status: 'pending', now: AT });
    await store.record({ ...BOB, event: event('b1'), status: 'pending', now: AT });

    const pending = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(pending.map(item => item.id)).toEqual(['e1', 'e2']);
  });

  it('lets one claim win, and a claim that was left behind be taken again', async () => {
    const store = getStore();
    await store.record({ ...ALICE, event: event('e1'), status: 'pending', now: AT });

    const claim = { ...ALICE, event_id: 'e1', stale_before: AT };
    await expect(store.claim({ ...claim, claim_id: 'first', now: AT })).resolves.toBe(true);
    await expect(store.claim({ ...claim, claim_id: 'second', now: AT })).resolves.toBe(false);
    // A held claim hides the event from the list until it goes stale.
    await expect(store.listPending({ ...ALICE, kinds: CLASHES, stale_before: AT, limit: 10 })).resolves.toEqual([]);

    // The first holder never came back. Once its claim is older than the stale mark, another pass takes over.
    const listed = await store.listPending({ ...ALICE, kinds: CLASHES, stale_before: STALE_BEFORE, limit: 10 });
    expect(listed.map(item => item.id)).toEqual(['e1']);
    await expect(
      store.claim({ ...ALICE, event_id: 'e1', claim_id: 'third', now: LATER, stale_before: STALE_BEFORE }),
    ).resolves.toBe(true);
    // The first holder's late decision no longer counts.
    await expect(
      store.decide({ ...ALICE, event_id: 'e1', claim_id: 'first', decision: decision(), now: LATER }),
    ).resolves.toBe(false);
    await expect(
      store.decide({ ...ALICE, event_id: 'e1', claim_id: 'third', decision: decision(), now: LATER }),
    ).resolves.toBe(true);
    await expect(
      store.listPending({ ...ALICE, kinds: CLASHES, stale_before: new Date('2030-01-01'), limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('puts a released event back for the next pass and gives up after five failures', async () => {
    const store = getStore();
    await store.record({ ...ALICE, event: event('e1'), status: 'pending', now: AT });
    const claim = { ...ALICE, event_id: 'e1', now: AT, stale_before: AT };

    // Waiting for another pass is not a failure, so it never counts toward giving up.
    await store.claim({ ...claim, claim_id: 'busy' });
    await expect(store.release({ ...ALICE, event_id: 'e1', claim_id: 'busy', failed: false })).resolves.toBe('pending');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(store.claim({ ...claim, claim_id: `c${String(attempt)}` })).resolves.toBe(true);
      await expect(
        store.release({ ...ALICE, event_id: 'e1', claim_id: `c${String(attempt)}`, failed: true }),
      ).resolves.toBe('pending');
    }
    await expect(store.claim({ ...claim, claim_id: 'c5' })).resolves.toBe(true);
    await expect(store.release({ ...ALICE, event_id: 'e1', claim_id: 'c5', failed: true })).resolves.toBe('failed');
    await expect(store.claim({ ...claim, claim_id: 'c6' })).resolves.toBe(false);
  });

  it('tracks events by due date, moves one to pending once, and drops them', async () => {
    const store = getStore();
    const later = event('b2', { kind: 'bill_due', due_at: '2026-11-10T00:00:00.000Z' });
    const sooner = event('b1', { kind: 'bill_due', due_at: '2026-11-07T00:00:00.000Z' });
    const far = event('b3', { kind: 'bill_due', due_at: '2026-12-30T00:00:00.000Z' });
    for (const item of [later, sooner, far]) {
      await store.record({ ...ALICE, event: item, status: 'tracking', now: AT });
    }
    await store.record({
      ...BOB,
      event: event('b4', { kind: 'bill_due', due_at: '2026-11-06T00:00:00.000Z' }),
      status: 'tracking',
      now: AT,
    });

    const before = new Date('2026-11-11T00:00:00.000Z');
    const due = await store.listTracking({ ...ALICE, due_before: before, limit: 10 });
    expect(due.map(item => item.id)).toEqual(['b1', 'b2']);

    await expect(store.promote({ ...ALICE, event_id: 'b1' })).resolves.toBe(true);
    await expect(store.promote({ ...ALICE, event_id: 'b1' })).resolves.toBe(false);
    const pending = await store.listPending({ ...ALICE, kinds: ['bill_due'], stale_before: AT, limit: 10 });
    expect(pending.map(item => item.id)).toEqual(['b1']);

    await store.drop({ ...ALICE, event_id: 'b2' });
    await expect(store.listTracking({ ...ALICE, due_before: before, limit: 10 })).resolves.toEqual([]);
    await expect(store.promote({ ...ALICE, event_id: 'b2' })).resolves.toBe(false);
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
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toBeUndefined();
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', checked_at: new Date('2026-11-05T10:00:00.000Z') });
    await store.setCheckpoint({ ...ALICE, watcher: 'mail', checked_at: new Date('2026-11-05T10:10:00.000Z') });
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'mail' })).resolves.toEqual(
      new Date('2026-11-05T10:10:00.000Z'),
    );
    await expect(store.getCheckpoint({ ...ALICE, watcher: 'calendar' })).resolves.toBeUndefined();
    await expect(store.getCheckpoint({ ...BOB, watcher: 'mail' })).resolves.toBeUndefined();
  });
}
