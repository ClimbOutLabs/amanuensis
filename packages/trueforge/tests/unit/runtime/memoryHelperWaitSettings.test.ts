/** How long a sorting or tidying question may wait for the model: the person's choice, else ten minutes. */
import { createLogger } from 'winston';

import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  MEMORY_HELPER_WAIT_SETTING_KEY,
  parseHelperWaitMinutes,
  readMemoryHelperWaitMinutes,
} from '../../../src/runtime/memoryHelperWaitSettings';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';

const logger = createLogger({ silent: true });

describe('readMemoryHelperWaitMinutes', () => {
  it('is ten minutes when nothing is stored', async () => {
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: inMemoryGlobalSettingsStore(), logger })).toBe(10);
  });

  it('is the stored choice', async () => {
    const store = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: '30' });
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: store, logger })).toBe(30);
  });

  it.each(['0', '61', '2.5', 'ten', ''])('reads the stored value %p as not set', async value => {
    expect(parseHelperWaitMinutes(value)).toBeUndefined();
    const store = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: value });
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: store, logger })).toBe(10);
  });

  it('is ten minutes when the store cannot be read', async () => {
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore(),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: failing, logger })).toBe(10);
  });
});
