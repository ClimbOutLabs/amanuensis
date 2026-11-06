/**
 * Backend-agnostic behavioural contract for IPhoneCallStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IPhoneCallStore } from '../../src/db/phoneCallStore';

const NOW = new Date('2026-11-06T15:00:00.000Z');
const SID = `CA${'1'.repeat(32)}`;
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

async function ringing(store: IPhoneCallStore, { id = 'call-1', fallback = true } = {}) {
  await store.create({
    id,
    tenant_id: 't1',
    created_by: 'alice',
    delivery_id: 'delivery-1',
    fallback,
    now: NOW,
    expires_at: later(5 * 60_000),
  });
  await store.attachSid({ id, call_sid: id === 'call-1' ? SID : `CA${'2'.repeat(32)}` });
}

export function runPhoneCallStoreContractSuite(getStore: () => IPhoneCallStore): void {
  it('starts dialing, then rings once Twilio names the call, and the name is set once', async () => {
    const store = getStore();
    const created = await store.create({
      id: 'call-1',
      tenant_id: 't1',
      created_by: 'alice',
      delivery_id: 'delivery-1',
      fallback: true,
      now: NOW,
      expires_at: later(60_000),
    });
    expect(created).toMatchObject({ status: 'dialing', call_sid: null, outcome: null, fallback: 'pending' });
    expect(await store.attachSid({ id: 'call-1', call_sid: SID })).toBe(true);
    expect(await store.attachSid({ id: 'call-1', call_sid: `CA${'9'.repeat(32)}` })).toBe(false);
    expect(await store.getBySid(SID)).toMatchObject({ id: 'call-1', status: 'ringing', created_at: NOW.toISOString() });
    expect(await store.get('call-1')).toMatchObject({ call_sid: SID });
    expect(await store.get('nope')).toBeUndefined();
  });

  it('gives out a media token only while the call rings or waits for its line, and never after it expired', async () => {
    const store = getStore();
    await ringing(store);
    const token = { call_sid: SID, token_hash: 'h1', token_expires_at: later(30_000), mode: 'talk' as const };
    expect(await store.issueToken({ ...token, now: later(10 * 60_000) })).toBe(false);
    expect(await store.issueToken({ ...token, now: NOW })).toBe(true);
    expect(await store.getBySid(SID)).toMatchObject({ status: 'connecting', mode: 'talk' });
    // A retried webhook replaces the waiting token, so only the newest one opens the line.
    expect(await store.issueToken({ ...token, token_hash: 'h2', now: later(1_000) })).toBe(true);
    expect(await store.redeemToken({ call_sid: SID, token_hash: 'h1', now: later(2_000) })).toBeUndefined();
    expect(await store.redeemToken({ call_sid: SID, token_hash: 'h2', now: later(2_000) })).toMatchObject({
      status: 'connected',
    });
    expect(await store.issueToken({ ...token, token_hash: 'h3', now: later(3_000) })).toBe(false);
  });

  it('uses a token once, only for its own call and only before it expires', async () => {
    const store = getStore();
    await ringing(store);
    await ringing(store, { id: 'call-2' });
    await store.issueToken({
      call_sid: SID,
      token_hash: 'h1',
      token_expires_at: later(30_000),
      mode: 'voicemail',
      now: NOW,
    });
    expect(await store.redeemToken({ call_sid: `CA${'2'.repeat(32)}`, token_hash: 'h1', now: NOW })).toBeUndefined();
    expect(await store.redeemToken({ call_sid: SID, token_hash: 'wrong', now: NOW })).toBeUndefined();
    expect(await store.redeemToken({ call_sid: SID, token_hash: 'h1', now: later(31_000) })).toBeUndefined();
    const redeemed = await store.redeemToken({ call_sid: SID, token_hash: 'h1', now: later(1_000) });
    expect(redeemed).toMatchObject({ id: 'call-1', status: 'connected', mode: 'voicemail' });
    expect(await store.redeemToken({ call_sid: SID, token_hash: 'h1', now: later(2_000) })).toBeUndefined();
  });

  it('ends a call once, and keeps its outcome and chat', async () => {
    const store = getStore();
    await ringing(store);
    await store.setSession({ id: 'call-1', session_id: 'chat-1' });
    expect(await store.finish({ id: 'call-1', outcome: 'answered', now: later(60_000) })).toBe(true);
    expect(await store.finish({ id: 'call-1', outcome: 'no_answer', now: later(61_000) })).toBe(false);
    expect(await store.get('call-1')).toMatchObject({
      status: 'ended',
      outcome: 'answered',
      session_id: 'chat-1',
      ended_at: later(60_000).toISOString(),
    });
  });

  it('lets a missed call fall back once, and a test call never', async () => {
    const store = getStore();
    await ringing(store);
    await ringing(store, { id: 'call-2', fallback: false });
    expect(await store.claimFallback('call-1')).toBe(true);
    expect(await store.claimFallback('call-1')).toBe(false);
    expect(await store.claimFallback('call-2')).toBe(false);
  });

  it('lists the calls started before a time that never ended', async () => {
    const store = getStore();
    await ringing(store);
    await ringing(store, { id: 'call-2' });
    await store.create({
      id: 'call-3',
      tenant_id: 't1',
      created_by: 'alice',
      delivery_id: 'delivery-3',
      fallback: true,
      now: later(60_000),
      expires_at: later(6 * 60_000),
    });
    await store.finish({ id: 'call-2', outcome: 'answered', now: later(1_000) });
    expect((await store.listUnfinished({ created_before: later(30_000) })).map(call => call.id)).toEqual(['call-1']);
    expect((await store.listUnfinished({ created_before: later(90_000) })).map(call => call.id).sort()).toEqual([
      'call-1',
      'call-3',
    ]);
  });

  it('forgets calls that ended before a time, and keeps the rest', async () => {
    const store = getStore();
    await ringing(store);
    await ringing(store, { id: 'call-2' });
    await store.finish({ id: 'call-1', outcome: 'no_answer', now: later(1_000) });
    await store.finish({ id: 'call-2', outcome: 'answered', now: later(5_000) });
    expect(await store.prune({ ended_before: later(2_000) })).toBe(1);
    expect(await store.get('call-1')).toBeUndefined();
    expect(await store.get('call-2')).toBeDefined();
  });
}
