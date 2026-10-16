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

  it('listSettings returns every row ordered by key, and reflects deletes', async () => {
    const store = getStore();
    expect(await store.listSettings()).toEqual([]);

    await store.setSetting({ key: 'zeta', value: '1' });
    await store.setSetting({ key: 'alpha', value: '2' });
    await store.setSetting({ key: 'middle', value: '3' });

    const listed = await store.listSettings();
    expect(listed.map(row => row.key)).toEqual(['alpha', 'middle', 'zeta']);
    expect(listed.map(row => row.value)).toEqual(['2', '3', '1']);

    await store.deleteSetting({ key: 'middle' });
    expect((await store.listSettings()).map(row => row.key)).toEqual(['alpha', 'zeta']);
  });

  it('deleteSetting removes the row; deleting a missing key is a no-op', async () => {
    const store = getStore();
    await store.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });

    await store.deleteSetting({ key: 'tool_output_screen_enabled' });
    expect(await store.getSetting({ key: 'tool_output_screen_enabled' })).toBeUndefined();

    await expect(store.deleteSetting({ key: 'tool_output_screen_enabled' })).resolves.toBeUndefined();
  });
}
