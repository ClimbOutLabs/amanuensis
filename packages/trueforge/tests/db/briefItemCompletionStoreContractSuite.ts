/**
 * Backend-agnostic behavioural contract for IBriefItemCompletionStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IBriefItemCompletionStore } from '../../src/db/briefItemCompletionStore';

const OWNER = { tenant_id: 't1', created_by: 'u1' };
const SINCE_WEEK = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function markInput(overrides: { item_key?: string; title?: string; created_by?: string; tenant_id?: string }) {
  return {
    tenant_id: overrides.tenant_id ?? OWNER.tenant_id,
    created_by: overrides.created_by ?? OWNER.created_by,
    item_key: overrides.item_key ?? 'bi_00000001',
    section: 'decision' as const,
    title: overrides.title ?? 'Reply to Dana',
  };
}

export function runBriefItemCompletionStoreContractSuite(getStore: () => IBriefItemCompletionStore): void {
  it('marking an item twice keeps one row and refreshes completed_at', async () => {
    const store = getStore();
    const first = await store.markDone(markInput({ title: 'Reply to Dana' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await store.markDone(markInput({ title: 'Reply to Dana (updated)' }));

    const rows = await store.listCompletedSince({ ...OWNER, since: SINCE_WEEK });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      item_key: 'bi_00000001',
      section: 'decision',
      title: 'Reply to Dana (updated)',
      completed_at: second.completed_at,
    });
    expect(second.completed_at > first.completed_at).toBe(true);
  });

  it('undo removes the row and reports its title once; a second undo finds nothing', async () => {
    const store = getStore();
    await store.markDone(markInput({}));

    await expect(store.undo({ ...OWNER, item_key: 'bi_00000001' })).resolves.toEqual({ title: 'Reply to Dana' });
    await expect(store.undo({ ...OWNER, item_key: 'bi_00000001' })).resolves.toBeUndefined();
    await expect(store.listCompletedSince({ ...OWNER, since: SINCE_WEEK })).resolves.toEqual([]);
  });

  it('lists only items completed at or after since', async () => {
    const store = getStore();
    await store.markDone(markInput({ item_key: 'bi_00000001', title: 'Old enough' }));

    const future = new Date(Date.now() + 60_000);
    await expect(store.listCompletedSince({ ...OWNER, since: future })).resolves.toEqual([]);
    const recent = await store.listCompletedSince({ ...OWNER, since: new Date(Date.now() - 60_000) });
    expect(recent.map(row => row.title)).toEqual(['Old enough']);
  });

  it('keeps another owner’s items out of listings and undo', async () => {
    const store = getStore();
    await store.markDone(markInput({ created_by: 'u1', item_key: 'bi_shared' }));
    await store.markDone(markInput({ created_by: 'u2', item_key: 'bi_shared', title: 'Mine only' }));

    const u2Rows = await store.listCompletedSince({ tenant_id: 't1', created_by: 'u2', since: SINCE_WEEK });
    expect(u2Rows.map(row => row.title)).toEqual(['Mine only']);

    await expect(store.undo({ tenant_id: 't1', created_by: 'u3', item_key: 'bi_shared' })).resolves.toBeUndefined();
    await expect(store.undo({ tenant_id: 't2', created_by: 'u1', item_key: 'bi_shared' })).resolves.toBeUndefined();
    const u1Rows = await store.listCompletedSince({ ...OWNER, since: SINCE_WEEK });
    expect(u1Rows.map(row => row.title)).toEqual(['Reply to Dana']);
  });

  it('returns completed_at as an ISO 8601 UTC string', async () => {
    const store = getStore();
    await store.markDone(markInput({}));
    const [row] = await store.listCompletedSince({ ...OWNER, since: SINCE_WEEK });
    expect(row?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
}
