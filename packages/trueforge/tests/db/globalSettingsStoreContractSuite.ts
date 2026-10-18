/**
 * Backend-agnostic behavioural contract for IGlobalSettingsStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IGlobalSettingsStore } from '../../src/db/globalSettingsStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function runGlobalSettingsStoreContractSuite(getStore: () => IGlobalSettingsStore): void {
  it('getSetting returns undefined when nothing is stored for the key', async () => {
    const store = getStore();
    expect(await store.getSetting({ key: 'missing' })).toBeUndefined();
  });

  it('setSetting creates a row and round-trips key, value, and updated_at', async () => {
    const store = getStore();
    const created = await store.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });

    expect(created.key).toBe('tool_output_screen_enabled');
    expect(created.value).toBe('true');
    expect(created.updated_at).toMatch(ISO_UTC);

    const fetched = await store.getSetting({ key: 'tool_output_screen_enabled' });
    expect(fetched).toEqual(created);
  });

  it('setSetting replaces the value for an existing key', async () => {
    const store = getStore();
    await store.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });

    const updated = await store.setSetting({ key: 'tool_output_screen_enabled', value: 'false' });
    expect(updated.value).toBe('false');

    const fetched = await store.getSetting({ key: 'tool_output_screen_enabled' });
    expect(fetched?.value).toBe('false');
  });

  it('keys are independent of each other', async () => {
    const store = getStore();
    await store.setSetting({ key: 'a', value: '1' });
    await store.setSetting({ key: 'b', value: '2' });

    expect((await store.getSetting({ key: 'a' }))?.value).toBe('1');
    expect((await store.getSetting({ key: 'b' }))?.value).toBe('2');
  });

  it('deleteSetting removes the row; deleting a missing key is a no-op', async () => {
    const store = getStore();
    await store.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });

    await store.deleteSetting({ key: 'tool_output_screen_enabled' });
    expect(await store.getSetting({ key: 'tool_output_screen_enabled' })).toBeUndefined();

    await expect(store.deleteSetting({ key: 'tool_output_screen_enabled' })).resolves.toBeUndefined();
  });

  it('compareAndSetSetting inserts only when the key is absent', async () => {
    const store = getStore();
    expect(await store.compareAndSetSetting({ key: 'lock', expected: null, value: 'first' })).toBe(true);
    expect(await store.compareAndSetSetting({ key: 'lock', expected: null, value: 'second' })).toBe(false);
    expect((await store.getSetting({ key: 'lock' }))?.value).toBe('first');
  });

  it('compareAndSetSetting replaces or removes only the expected value', async () => {
    const store = getStore();
    await store.setSetting({ key: 'lock', value: 'first' });
    expect(await store.compareAndSetSetting({ key: 'lock', expected: 'other', value: 'second' })).toBe(false);
    expect(await store.compareAndSetSetting({ key: 'lock', expected: 'first', value: 'second' })).toBe(true);
    expect((await store.getSetting({ key: 'lock' }))?.value).toBe('second');
    expect(await store.compareAndSetSetting({ key: 'lock', expected: 'first', value: null })).toBe(false);
    expect(await store.compareAndSetSetting({ key: 'lock', expected: 'second', value: null })).toBe(true);
    expect(await store.getSetting({ key: 'lock' })).toBeUndefined();
  });

  it('compareAndSetSetting lets exactly one of several concurrent inserts win', async () => {
    const store = getStore();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map(value => store.compareAndSetSetting({ key: 'lock', expected: null, value })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
}
