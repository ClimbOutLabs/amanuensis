/**
 * Backend-agnostic behavioural contract for ITokenFactoryUsageStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ITokenFactoryUsageStore } from '../../src/db/tokenFactoryUsageStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function runTokenFactoryUsageStoreContractSuite(getStore: () => ITokenFactoryUsageStore): void {
  it('getUsage returns undefined for a day nothing was counted on', async () => {
    expect(await getStore().getUsage({ usage_date: '2026-10-15' })).toBeUndefined();
  });

  it('addUsage creates the day row and round-trips it', async () => {
    const store = getStore();
    const created = await store.addUsage({ usage_date: '2026-10-15', tokens: 1200 });

    expect(created.usage_date).toBe('2026-10-15');
    expect(created.used_tokens).toBe(1200);
    expect(created.updated_at).toMatch(ISO_UTC);
    expect(await store.getUsage({ usage_date: '2026-10-15' })).toEqual(created);
  });

  it('addUsage accumulates on the same day', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', tokens: 1200 });
    const second = await store.addUsage({ usage_date: '2026-10-15', tokens: 300 });

    expect(second.used_tokens).toBe(1500);
  });

  it('counts concurrent additions without losing any', async () => {
    const store = getStore();
    await Promise.all(Array.from({ length: 20 }, () => store.addUsage({ usage_date: '2026-10-15', tokens: 50 })));

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(1000);
  });

  it('keeps each UTC day in its own row', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', tokens: 900 });
    await store.addUsage({ usage_date: '2026-10-16', tokens: 40 });

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(900);
    expect((await store.getUsage({ usage_date: '2026-10-16' }))?.used_tokens).toBe(40);
  });

  it('holds totals beyond 32 bits', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', tokens: 3_000_000_000 });
    const total = await store.addUsage({ usage_date: '2026-10-15', tokens: 3_000_000_000 });

    expect(total.used_tokens).toBe(6_000_000_000);
  });
}
