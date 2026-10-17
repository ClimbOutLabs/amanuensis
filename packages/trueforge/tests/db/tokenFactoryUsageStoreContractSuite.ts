/**
 * Backend-agnostic behavioural contract for ITokenFactoryUsageStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ITokenFactoryUsageStore } from '../../src/db/tokenFactoryUsageStore';

const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function runTokenFactoryUsageStoreContractSuite(getStore: () => ITokenFactoryUsageStore): void {
  it('getUsage returns undefined for a day nothing was counted on', async () => {
    expect(await getStore().getUsage({ usage_date: '2026-10-15' })).toBeUndefined();
  });

  it('addUsage creates the day row and round-trips it', async () => {
    const store = getStore();
    const created = await store.addUsage({
      usage_date: '2026-10-15',
      model_id: SUPER,
      input_tokens: 1000,
      output_tokens: 200,
    });

    expect(created.usage_date).toBe('2026-10-15');
    expect(created.used_tokens).toBe(1200);
    expect(created.updated_at).toMatch(ISO_UTC);
    expect(await store.getUsage({ usage_date: '2026-10-15' })).toEqual(created);
  });

  it('addUsage accumulates on the same day', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 1000, output_tokens: 200 });
    const second = await store.addUsage({
      usage_date: '2026-10-15',
      model_id: SUPER,
      input_tokens: 200,
      output_tokens: 100,
    });

    expect(second.used_tokens).toBe(1500);
  });

  it('counts concurrent additions without losing any', async () => {
    const store = getStore();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 30, output_tokens: 20 }),
      ),
    );

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(1000);
  });

  it('keeps each UTC day in its own row', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 600, output_tokens: 300 });
    await store.addUsage({ usage_date: '2026-10-16', model_id: SUPER, input_tokens: 30, output_tokens: 10 });

    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(900);
    expect((await store.getUsage({ usage_date: '2026-10-16' }))?.used_tokens).toBe(40);
  });

  it('holds totals beyond 32 bits', async () => {
    const store = getStore();
    await store.addUsage({
      usage_date: '2026-10-15',
      model_id: SUPER,
      input_tokens: 2_000_000_000,
      output_tokens: 1_000_000_000,
    });
    const total = await store.addUsage({
      usage_date: '2026-10-15',
      model_id: SUPER,
      input_tokens: 2_000_000_000,
      output_tokens: 1_000_000_000,
    });

    expect(total.used_tokens).toBe(6_000_000_000);
  });

  it('splits the day by model and counts each call', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 1000, output_tokens: 200 });
    await store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 400, output_tokens: 100 });
    await store.addUsage({ usage_date: '2026-10-15', model_id: NANO, input_tokens: 90, output_tokens: 10 });

    expect(await store.listModelUsage({ usage_date: '2026-10-15' })).toEqual([
      { usage_date: '2026-10-15', model_id: SUPER, input_tokens: 1400, output_tokens: 300, calls: 2 },
      { usage_date: '2026-10-15', model_id: NANO, input_tokens: 90, output_tokens: 10, calls: 1 },
    ]);
    expect((await store.getUsage({ usage_date: '2026-10-15' }))?.used_tokens).toBe(1800);
  });

  it('lists nothing for a day with no usage and keeps days apart', async () => {
    const store = getStore();
    await store.addUsage({ usage_date: '2026-10-15', model_id: SUPER, input_tokens: 5, output_tokens: 5 });

    expect(await store.listModelUsage({ usage_date: '2026-10-16' })).toEqual([]);
  });

  it('counts concurrent additions per model without losing any', async () => {
    const store = getStore();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.addUsage({ usage_date: '2026-10-15', model_id: NANO, input_tokens: 3, output_tokens: 2 }),
      ),
    );

    expect(await store.listModelUsage({ usage_date: '2026-10-15' })).toEqual([
      { usage_date: '2026-10-15', model_id: NANO, input_tokens: 60, output_tokens: 40, calls: 20 },
    ]);
  });
}
