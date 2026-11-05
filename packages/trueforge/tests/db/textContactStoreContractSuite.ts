/**
 * Backend-agnostic behavioural contract for ITextContactStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ITextContactStore, TextContactOwner } from '../../src/db/textContactStore';
import type { TextContact } from '../../src/schemas/textMessages';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };
const AT = new Date('2026-11-06T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;

function code(hash = 'h') {
  return { hash, salt: `${hash}-salt`, expires_at: '2026-11-06T10:10:00.000Z' };
}

function contact(overrides: Partial<TextContact> = {}): TextContact {
  return {
    phone: '+15550100',
    mode: 'private',
    confirmed_at: null,
    opted_out_at: null,
    pending_phone: null,
    code_hash: null,
    code_salt: null,
    code_expires_at: null,
    code_attempts: 0,
    ...overrides,
  };
}

function later(minutes: number): Date {
  return new Date(AT.getTime() + minutes * 60_000);
}

export function runTextContactStoreContractSuite(getStore: () => ITextContactStore): void {
  async function confirmed(store: ITextContactStore, owner: TextContactOwner, phone = '+15550100') {
    await store.startCode({ ...owner, phone, as: 'number', code: code('seed'), now: AT });
    await expect(store.confirmCode({ ...owner, code_hash: 'seed', now: AT })).resolves.toBe(true);
  }

  it('has nothing until a number is entered', async () => {
    const store = getStore();
    await expect(store.get(ALICE)).resolves.toBeUndefined();
    await expect(store.countCodeAttempt(ALICE)).resolves.toBeUndefined();
  });

  it('starts a code for a first number, unconfirmed', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await expect(store.get(ALICE)).resolves.toEqual(
      contact({ code_hash: 'h', code_salt: 'h-salt', code_expires_at: '2026-11-06T10:10:00.000Z' }),
    );
  });

  it('a fresh code for the same number keeps its confirmation; another number starts over', async () => {
    const store = getStore();
    await confirmed(store, ALICE);
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code('again'), now: AT });
    await expect(store.get(ALICE)).resolves.toMatchObject({
      confirmed_at: AT.toISOString(),
      code_hash: 'again',
      code_attempts: 0,
    });
    await store.startCode({ ...ALICE, phone: '+15550111', as: 'number', code: code('other'), now: AT });
    await expect(store.get(ALICE)).resolves.toMatchObject({
      phone: '+15550111',
      confirmed_at: null,
      code_hash: 'other',
    });
  });

  it('keeps a new number beside a confirmed one, and swaps them only when its code is confirmed', async () => {
    const store = getStore();
    await expect(
      store.startCode({ ...ALICE, phone: '+15550122', as: 'new_number', code: code('new'), now: AT }),
    ).resolves.toBe(false);
    await confirmed(store, ALICE);
    await expect(
      store.startCode({ ...ALICE, phone: '+15550122', as: 'new_number', code: code('new'), now: AT }),
    ).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toMatchObject({
      phone: '+15550100',
      pending_phone: '+15550122',
      confirmed_at: AT.toISOString(),
      code_hash: 'new',
    });
    await expect(store.confirmCode({ ...ALICE, code_hash: 'new', now: later(1) })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(
      contact({ phone: '+15550122', confirmed_at: later(1).toISOString() }),
    );
  });

  it('confirms and clears a code only while it is still the code that was read', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code('first'), now: AT });
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code('second'), now: AT });
    await expect(store.confirmCode({ ...ALICE, code_hash: 'first', now: AT })).resolves.toBe(false);
    await expect(store.clearCode({ ...ALICE, code_hash: 'first', now: AT })).resolves.toBe(false);
    await expect(store.get(ALICE)).resolves.toMatchObject({ code_hash: 'second', confirmed_at: null });
    await expect(store.clearCode({ ...ALICE, code_hash: 'second', now: AT })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(contact());
  });

  it('clearing a code to a new number drops the new number and keeps the confirmed one', async () => {
    const store = getStore();
    await confirmed(store, ALICE);
    await store.startCode({ ...ALICE, phone: '+15550122', as: 'new_number', code: code('new'), now: AT });
    await expect(store.clearCode({ ...ALICE, code_hash: 'new', now: AT })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(contact({ confirmed_at: AT.toISOString() }));
  });

  it('counts tries at the code in the database and stops counting once no code is pending', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await expect(store.countCodeAttempt(ALICE)).resolves.toBe(1);
    await expect(store.countCodeAttempt(ALICE)).resolves.toBe(2);
    await store.clearCode({ ...ALICE, code_hash: 'h', now: AT });
    await expect(store.countCodeAttempt(ALICE)).resolves.toBeUndefined();
  });

  it('sets the choice of words only when there is a number', async () => {
    const store = getStore();
    await expect(store.setMode({ ...ALICE, mode: 'full', now: AT })).resolves.toBe(false);
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await expect(store.setMode({ ...ALICE, mode: 'full', now: AT })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toMatchObject({ mode: 'full', code_hash: 'h' });
  });

  it('keeps each person and tenant apart', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await expect(store.get(BOB)).resolves.toBeUndefined();
    await expect(store.get(OTHER_TENANT)).resolves.toBeUndefined();
    await expect(store.remove(BOB)).resolves.toBe(false);
    await expect(store.confirmCode({ ...BOB, code_hash: 'h', now: AT })).resolves.toBe(false);
    await expect(store.countCodeAttempt(OTHER_TENANT)).resolves.toBeUndefined();
    await expect(store.get(ALICE)).resolves.toMatchObject({ code_hash: 'h', code_attempts: 0 });
  });

  it('a STOP opts the number out for everyone who has it, across tenants, and drops it where it waits as new', async () => {
    const store = getStore();
    await confirmed(store, ALICE);
    await confirmed(store, OTHER_TENANT);
    await confirmed(store, BOB, '+15550133');
    await store.startCode({ ...BOB, phone: '+15550100', as: 'new_number', code: code('bob-new'), now: AT });
    const stopped = await store.optOut({ phone: '+15550100', now: later(5) });
    expect(stopped.opted_out.map(owner => `${owner.tenant_id}/${owner.created_by}`).sort()).toEqual([
      't1/alice',
      't2/alice',
    ]);
    expect(stopped.pending_dropped).toEqual([BOB]);
    await expect(store.get(ALICE)).resolves.toEqual(contact({ opted_out_at: later(5).toISOString() }));
    await expect(store.get(BOB)).resolves.toEqual(contact({ phone: '+15550133', confirmed_at: AT.toISOString() }));
    await expect(store.optOut({ phone: '+15550177', now: AT })).resolves.toEqual({
      opted_out: [],
      pending_dropped: [],
    });
  });

  it('removes a number', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await expect(store.remove(ALICE)).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toBeUndefined();
  });

  it('imports a number unconfirmed, and only when the person has none', async () => {
    const store = getStore();
    await expect(store.importContact({ ...ALICE, contact: { phone: '+15550100', mode: 'full' } })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(contact({ mode: 'full' }));
    await expect(store.importContact({ ...ALICE, contact: { phone: '+15550199', mode: 'private' } })).resolves.toBe(
      false,
    );
    await expect(store.get(ALICE)).resolves.toEqual(contact({ mode: 'full' }));
  });

  it('claims code sends up to the limit in a window, then frees up when the window is over', async () => {
    const store = getStore();
    const claim = (now: Date) => store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 2, now });
    await expect(claim(AT)).resolves.toEqual({ ok: true });
    await expect(claim(later(10))).resolves.toEqual({ ok: true });
    await expect(claim(later(20))).resolves.toEqual({ ok: false, window_started_at: AT.toISOString() });
    await expect(store.claimCodeSend({ key: 'other', window_ms: HOUR_MS, max: 2, now: later(20) })).resolves.toEqual({
      ok: true,
    });
    await expect(claim(later(60))).resolves.toEqual({ ok: true });
    await expect(claim(later(61))).resolves.toEqual({ ok: true });
    await expect(claim(later(62))).resolves.toEqual({ ok: false, window_started_at: later(60).toISOString() });
  });

  it('claims at the same moment never pass the limit together', async () => {
    const store = getStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 3, now: AT })),
    );
    expect(results.filter(result => result.ok)).toHaveLength(3);
  });

  it('claims outlive the number and are forgotten only once old', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 1, now: AT });
    await store.remove(ALICE);
    await expect(store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 1, now: later(1) })).resolves.toMatchObject({
      ok: false,
    });
    await store.forgetCodeSends({ before: AT });
    await expect(store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 1, now: later(2) })).resolves.toMatchObject({
      ok: false,
    });
    await store.forgetCodeSends({ before: later(1) });
    await expect(store.claimCodeSend({ key: 'k', window_ms: HOUR_MS, max: 1, now: later(3) })).resolves.toEqual({
      ok: true,
    });
  });
}
