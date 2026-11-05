/**
 * Backend-agnostic behavioural contract for INoticingStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { INoticingStore, NoticingDecision } from '../../src/db/noticingStore';
import type { NoticingEvent } from '../../src/schemas/reach';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };

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

export function runNoticingStoreContractSuite(getStore: () => INoticingStore): void {
  it('claims an event once and says seen after that', async () => {
    const store = getStore();
    await expect(store.claim({ ...ALICE, event: event('e1'), status: 'raised' })).resolves.toBe('new');
    await expect(store.claim({ ...ALICE, event: event('e1'), status: 'raised' })).resolves.toBe('seen');
    await expect(store.claim({ ...BOB, event: event('e1'), status: 'raised' })).resolves.toBe('new');
  });

  it('records a decision once and reads it back', async () => {
    const store = getStore();
    await store.claim({ ...ALICE, event: event('e1'), status: 'raised' });
    const at = new Date('2026-11-05T10:05:00.000Z');
    await expect(store.decide({ ...ALICE, event_id: 'e1', decision: decision(), now: at })).resolves.toBe(true);
    await expect(store.decide({ ...ALICE, event_id: 'e1', decision: decision(), now: at })).resolves.toBe(false);
    const record = await store.get({ ...ALICE, event_id: 'e1' });
    expect(record?.status).toBe('raised');
    expect(record?.decision).toEqual({ ...decision(), decided_at: at.toISOString() });
    await expect(store.get({ ...BOB, event_id: 'e1' })).resolves.toBeUndefined();
  });

  it('releases a claim so the event can be raised again', async () => {
    const store = getStore();
    await store.claim({ ...ALICE, event: event('e1'), status: 'raised' });
    await store.release({ ...ALICE, event_id: 'e1' });
    await expect(store.claim({ ...ALICE, event: event('e1'), status: 'raised' })).resolves.toBe('new');
  });

  it('lists tracked events by due date and drops them', async () => {
    const store = getStore();
    const later = event('b2', { kind: 'bill_due', due_at: '2026-11-10T00:00:00.000Z' });
    const sooner = event('b1', { kind: 'bill_due', due_at: '2026-11-07T00:00:00.000Z' });
    const far = event('b3', { kind: 'bill_due', due_at: '2026-12-30T00:00:00.000Z' });
    for (const item of [later, sooner, far]) {
      await store.claim({ ...ALICE, event: item, status: 'tracking' });
    }
    await store.claim({
      ...BOB,
      event: event('b4', { kind: 'bill_due', due_at: '2026-11-06T00:00:00.000Z' }),
      status: 'tracking',
    });

    const due = await store.listTracking({ ...ALICE, due_before: new Date('2026-11-11T00:00:00.000Z'), limit: 10 });
    expect(due.map(item => item.event.id)).toEqual(['b1', 'b2']);

    await store.drop({ ...ALICE, event_id: 'b1' });
    const after = await store.listTracking({ ...ALICE, due_before: new Date('2026-11-11T00:00:00.000Z'), limit: 10 });
    expect(after.map(item => item.event.id)).toEqual(['b2']);
  });

  it('decides a tracked event once it is raised', async () => {
    const store = getStore();
    await store.claim({
      ...ALICE,
      event: event('b1', { kind: 'bill_due', due_at: '2026-11-07T00:00:00.000Z' }),
      status: 'tracking',
    });
    await expect(
      store.decide({ ...ALICE, event_id: 'b1', decision: decision({ model_level: 'nudge', decided_level: 'nudge' }) }),
    ).resolves.toBe(true);
    await expect(
      store.listTracking({ ...ALICE, due_before: new Date('2027-01-01T00:00:00.000Z'), limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('counts nudges since a time and finds the last call', async () => {
    const store = getStore();
    const times = ['2026-11-04T23:00:00.000Z', '2026-11-05T09:00:00.000Z', '2026-11-05T10:00:00.000Z'];
    for (const [index, at] of times.entries()) {
      const id = `e${String(index)}`;
      await store.claim({ ...ALICE, event: event(id), status: 'raised' });
      await store.decide({
        ...ALICE,
        event_id: id,
        decision: index === 2 ? decision() : decision({ model_level: 'nudge', decided_level: 'nudge' }),
        now: new Date(at),
      });
    }
    await store.claim({ ...ALICE, event: event('note1'), status: 'raised' });
    await store.decide({
      ...ALICE,
      event_id: 'note1',
      decision: decision({ model_level: 'note', decided_level: 'note', delivered_level: 'note' }),
      now: new Date('2026-11-05T11:00:00.000Z'),
    });

    await expect(store.countNudgesSince({ ...ALICE, since: new Date('2026-11-05T00:00:00.000Z') })).resolves.toBe(2);
    await expect(store.countNudgesSince({ ...BOB, since: new Date('2026-11-05T00:00:00.000Z') })).resolves.toBe(0);
    await expect(store.lastCallDecidedAt(ALICE)).resolves.toEqual(new Date('2026-11-05T10:00:00.000Z'));
    await expect(store.lastCallDecidedAt(BOB)).resolves.toBeUndefined();
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
