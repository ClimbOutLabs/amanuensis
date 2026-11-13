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
    const store = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: '15' });
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: store, logger })).toBe(15);
  });

  it.each(['0', '100', '2.5', 'ten', ''])('reads the stored value %p as not set', async value => {
    expect(parseHelperWaitMinutes(value)).toBeUndefined();
    const store = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: value });
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: store, logger })).toBe(10);
  });

  it.each(['21', '30', '60'])('reads the longer stored wait %p as twenty minutes', async value => {
    expect(parseHelperWaitMinutes(value)).toBe(20);
    const store = inMemoryGlobalSettingsStore({ [MEMORY_HELPER_WAIT_SETTING_KEY]: value });
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: store, logger })).toBe(20);
  });

  it('is ten minutes when the store cannot be read', async () => {
    const failing: IGlobalSettingsStore = {
      ...inMemoryGlobalSettingsStore(),
      getSetting: () => Promise.reject(new Error('db down')),
    };
    expect(await readMemoryHelperWaitMinutes({ globalSettingsStore: failing, logger })).toBe(10);
  });
});
