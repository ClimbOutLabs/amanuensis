/**
 * Backend-agnostic behavioural contract for ITextContactStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { PersonOwner } from '../../src/db/personOwner';
import type { ITextContactStore } from '../../src/db/textContactStore';
import type { TextContact } from '../../src/schemas/textMessages';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };
const AT = new Date('2026-11-06T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;

function code(hash = 'h') {
  return { hash, salt: `${hash}-salt`, key_id: 'k1', expires_at: '2026-11-06T10:10:00.000Z' };
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
    code_key_id: null,
    code_expires_at: null,
    code_attempts: 0,
    ...overrides,
  };
}

function later(minutes: number): Date {
  return new Date(AT.getTime() + minutes * 60_000);
}

export function runTextContactStoreContractSuite(getStore: () => ITextContactStore): void {
  async function confirmed(store: ITextContactStore, owner: PersonOwner, phone = '+15550100') {
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
      contact({ code_hash: 'h', code_salt: 'h-salt', code_key_id: 'k1', code_expires_at: '2026-11-06T10:10:00.000Z' }),
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
    const mallory = { tenant_id: 't1', created_by: 'mallory' };
    await store.startCode({ ...mallory, phone: '+15550100', as: 'number', code: code('mallory'), now: AT });
    const stopped = await store.optOut({ phone: '+15550100', now: later(5) });
    expect(stopped.opted_out.map(owner => `${owner.tenant_id}/${owner.created_by}`).sort()).toEqual([
      't1/alice',
      't2/alice',
    ]);
    expect(stopped.unconfirmed_dropped).toEqual([mallory]);
    expect(stopped.pending_dropped).toEqual([BOB]);
    // The person who confirmed it keeps that mark, so a STOP does not make the number anyone's to claim.
    await expect(store.get(ALICE)).resolves.toEqual(
      contact({ confirmed_at: AT.toISOString(), opted_out_at: later(5).toISOString() }),
    );
    // A number only waiting for its code is dropped, so a STOP never leaves it marked under someone who never proved it.
    await expect(store.get(mallory)).resolves.toBeUndefined();
    await expect(store.get(BOB)).resolves.toEqual(contact({ phone: '+15550133', confirmed_at: AT.toISOString() }));
    await expect(store.optOut({ phone: '+15550177', now: AT })).resolves.toEqual({
      opted_out: [],
      unconfirmed_dropped: [],
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
    await expect(
      store.importContact({ ...ALICE, contact: { phone: '+15550100', mode: 'full', words: [] } }),
    ).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(contact({ mode: 'full' }));
    await expect(
      store.importContact({ ...ALICE, contact: { phone: '+15550199', mode: 'private', words: [] } }),
    ).resolves.toBe(false);
    await expect(store.get(ALICE)).resolves.toEqual(contact({ mode: 'full' }));
  });

  it('keeps the words a person lets Aman text, each person apart, up to a limit, with no word twice', async () => {
    const store = getStore();
    const add = (owner: typeof ALICE, word: string, max = 3) => store.addWord({ ...owner, word, max, now: AT });
    await expect(add(ALICE, 'patel')).resolves.toBe('added');
    await expect(add(ALICE, 'patel')).resolves.toBe('exists');
    await expect(add(ALICE, 'lopez')).resolves.toBe('added');
    await expect(add(BOB, 'zed')).resolves.toBe('added');
    await expect(add(ALICE, 'kim')).resolves.toBe('added');
    await expect(add(ALICE, 'extra')).resolves.toBe('full');
    await expect(store.listWords(ALICE)).resolves.toEqual(['kim', 'lopez', 'patel']);
    await expect(store.listWords(BOB)).resolves.toEqual(['zed']);
    await expect(store.removeWord({ ...ALICE, word: 'lopez' })).resolves.toBe(true);
    await expect(store.removeWord({ ...ALICE, word: 'lopez' })).resolves.toBe(false);
    await expect(store.listWords(ALICE)).resolves.toEqual(['kim', 'patel']);
  });

  it('keeps the words when the number is removed, and imports exported words without passing the limit', async () => {
    const store = getStore();
    await store.addWord({ ...ALICE, word: 'patel', max: 3, now: AT });
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await store.remove(ALICE);
    await expect(store.listWords(ALICE)).resolves.toEqual(['patel']);
    await store.importWords({ ...BOB, words: ['a', 'b', 'a', 'c', 'd'], max: 3, now: AT });
    await expect(store.listWords(BOB)).resolves.toEqual(['a', 'b', 'c']);
    await store.importWords({ ...BOB, words: ['b', 'z'], max: 3, now: AT });
    await expect(store.listWords(BOB)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('claims code sends up to the limit in a window, then frees up when the window is over', async () => {
    const store = getStore();
    const limit = { key: 'k', window_ms: HOUR_MS, max: 2 };
    const claim = (now: Date) => store.claimTextSends({ limits: [limit], now });
    await expect(claim(AT)).resolves.toEqual({ ok: true });
    await expect(claim(later(10))).resolves.toEqual({ ok: true });
    await expect(claim(later(20))).resolves.toEqual({ ok: false, refused: limit, window_started_at: AT.toISOString() });
    await expect(
      store.claimTextSends({ limits: [{ key: 'other', window_ms: HOUR_MS, max: 2 }], now: later(20) }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(claim(later(60))).resolves.toEqual({ ok: true });
    await expect(claim(later(61))).resolves.toEqual({ ok: true });
    await expect(claim(later(62))).resolves.toEqual({
      ok: false,
      refused: limit,
      window_started_at: later(60).toISOString(),
    });
  });

  it('counts a send against every limit or against none, so a refusal by one limit spends none of the others', async () => {
    const store = getStore();
    const person = { key: 'person', window_ms: HOUR_MS, max: 5 };
    const number = { key: 'number', window_ms: HOUR_MS, max: 5 };
    const server = { key: 'server', window_ms: HOUR_MS, max: 1 };
    await expect(store.claimTextSends({ limits: [server], now: AT })).resolves.toEqual({ ok: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(store.claimTextSends({ limits: [person, number, server], now: later(1) })).resolves.toEqual({
        ok: false,
        refused: server,
        window_started_at: AT.toISOString(),
      });
    }
    // A limit of one still has room on each, so the refused sends counted nothing against them.
    await expect(
      store.claimTextSends({
        limits: [
          { ...person, max: 1 },
          { ...number, max: 1 },
        ],
        now: later(2),
      }),
    ).resolves.toEqual({ ok: true });
    await expect(store.claimTextSends({ limits: [person, number, server], now: later(61) })).resolves.toEqual({
      ok: true,
    });
  });

  it('claims at the same moment never pass the limit together', async () => {
    const store = getStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claimTextSends({ limits: [{ key: 'k', window_ms: HOUR_MS, max: 3 }], now: AT }),
      ),
    );
    expect(results.filter(result => result.ok)).toHaveLength(3);
  });

  it('claims of several limits at the same moment never pass a limit together, nor count a refused one', async () => {
    const store = getStore();
    const first = { key: 'first', window_ms: HOUR_MS, max: 5 };
    const second = { key: 'second', window_ms: HOUR_MS, max: 3 };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claimTextSends({ limits: [first, second], now: AT })),
    );
    expect(results.filter(result => result.ok)).toHaveLength(3);
    await expect(store.claimTextSends({ limits: [{ ...first, max: 4 }], now: AT })).resolves.toEqual({ ok: true });
  });

  it('claims outlive the number and are forgotten only once old', async () => {
    const store = getStore();
    await store.startCode({ ...ALICE, phone: '+15550100', as: 'number', code: code(), now: AT });
    await store.claimTextSends({ limits: [{ key: 'k', window_ms: HOUR_MS, max: 1 }], now: AT });
    await store.remove(ALICE);
    await expect(
      store.claimTextSends({ limits: [{ key: 'k', window_ms: HOUR_MS, max: 1 }], now: later(1) }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await store.forgetTextSends({ before: AT });
    await expect(
      store.claimTextSends({ limits: [{ key: 'k', window_ms: HOUR_MS, max: 1 }], now: later(2) }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await store.forgetTextSends({ before: later(1) });
    await expect(
      store.claimTextSends({ limits: [{ key: 'k', window_ms: HOUR_MS, max: 1 }], now: later(3) }),
    ).resolves.toEqual({
      ok: true,
    });
  });
}
