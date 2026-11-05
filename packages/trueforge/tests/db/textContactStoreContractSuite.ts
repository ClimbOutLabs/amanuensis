/**
 * Backend-agnostic behavioural contract for ITextContactStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ITextContactStore } from '../../src/db/textContactStore';
import type { TextContact } from '../../src/schemas/textMessages';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };

function contact(overrides: Partial<TextContact> = {}): TextContact {
  return {
    phone: '+15550100',
    mode: 'private',
    confirmed_at: null,
    opted_out_at: null,
    code_hash: null,
    code_salt: null,
    code_expires_at: null,
    code_attempts: 0,
    send_window_started_at: null,
    sends_in_window: 0,
    ...overrides,
  };
}

export function runTextContactStoreContractSuite(getStore: () => ITextContactStore): void {
  it('has nothing until a number is entered', async () => {
    const store = getStore();
    await expect(store.get(ALICE)).resolves.toBeUndefined();
    await expect(store.listByPhone('+15550100')).resolves.toEqual([]);
  });

  it('saves, replaces and reads back whole', async () => {
    const store = getStore();
    const first = contact({
      code_hash: 'h',
      code_salt: 's',
      code_expires_at: '2026-11-06T10:00:00.000Z',
      send_window_started_at: '2026-11-06T09:50:00.000Z',
      sends_in_window: 1,
    });
    await expect(store.put({ ...ALICE, contact: first })).resolves.toEqual(first);
    await expect(store.get(ALICE)).resolves.toEqual(first);
    const second = contact({ phone: '+15550111', mode: 'full', confirmed_at: '2026-11-06T09:55:00.000Z' });
    await store.put({ ...ALICE, contact: second });
    await expect(store.get(ALICE)).resolves.toEqual(second);
  });

  it('counts tries at the code in the database and stops counting once no code is pending', async () => {
    const store = getStore();
    await expect(store.countCodeAttempt(ALICE)).resolves.toBeUndefined();
    await store.put({ ...ALICE, contact: contact({ code_hash: 'h', code_salt: 's' }) });
    await expect(store.countCodeAttempt(ALICE)).resolves.toBe(1);
    await expect(store.countCodeAttempt(ALICE)).resolves.toBe(2);
    await store.put({ ...ALICE, contact: contact() });
    await expect(store.countCodeAttempt(ALICE)).resolves.toBeUndefined();
  });

  it('keeps each person and tenant apart', async () => {
    const store = getStore();
    await store.put({ ...ALICE, contact: contact() });
    await expect(store.get(BOB)).resolves.toBeUndefined();
    await expect(store.get(OTHER_TENANT)).resolves.toBeUndefined();
    await expect(store.remove(BOB)).resolves.toBe(false);
    await expect(store.get(ALICE)).resolves.toEqual(contact());
  });

  it('finds everyone who has a number, across tenants', async () => {
    const store = getStore();
    await store.put({ ...ALICE, contact: contact() });
    await store.put({ ...OTHER_TENANT, contact: contact({ mode: 'full' }) });
    await store.put({ ...BOB, contact: contact({ phone: '+15550122' }) });
    const found = await store.listByPhone('+15550100');
    expect(found.map(({ tenant_id, created_by }) => `${tenant_id}/${created_by}`)).toEqual(['t1/alice', 't2/alice']);
  });

  it('removes a number', async () => {
    const store = getStore();
    await store.put({ ...ALICE, contact: contact() });
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
}
