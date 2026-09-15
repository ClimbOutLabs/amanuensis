import { describe, expect, it } from 'vitest';

import { isSettingsChromeEnabled } from '@/server/settingsChrome.js';
import { createMockCatalog } from './mockServer.js';

/** Re-export path still works for Settings chrome. */
describe('isSettingsChromeEnabled', () => {
  const catalog = createMockCatalog();

  it('requires a catalog and defaults to enabled when the capability is absent', () => {
    expect(isSettingsChromeEnabled({ catalog: null, capabilities: null })).toBe(false);
    // A catalog with no capability payload, or a payload that omits `settings`, still
    // shows Settings: our frontend and some instances do not send this capability at
    // all, so an absent capability must not hide the chrome.
    expect(isSettingsChromeEnabled({ catalog, capabilities: null })).toBe(true);
    expect(isSettingsChromeEnabled({ catalog, capabilities: {} })).toBe(true);
    expect(
      isSettingsChromeEnabled({
        catalog,
        capabilities: { settings: { enabled: true } },
      }),
    ).toBe(true);
  });

  it('is false when settings capability is disabled', () => {
    expect(
      isSettingsChromeEnabled({
        catalog,
        capabilities: { settings: { enabled: false } },
      }),
    ).toBe(false);
  });
});
