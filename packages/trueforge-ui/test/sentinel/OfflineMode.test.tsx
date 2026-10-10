// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OfflineIndicator } from '@/sentinel/OfflineIndicator.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelSettings } from '@/sentinel/SentinelSettings.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';

function stubApi(settings: SentinelUserSettings): { api: SentinelApi; updateUserSettings: ReturnType<typeof vi.fn> } {
  const updateUserSettings = vi.fn(async (patch: Partial<SentinelUserSettings>) => ({
    ...settings,
    ...patch,
  }));
  const api: SentinelApi = {
    listAuditEntries: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings,
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  return { api, updateUserSettings };
}

describe('OfflineIndicator', () => {
  it('shows while the server settings say offline mode is on', async () => {
    const { api } = stubApi({ offline_mode: true, tier2_auto_allow: [] });
    render(
      <SentinelApiProvider api={api}>
        <OfflineIndicator />
      </SentinelApiProvider>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Offline mode');
  });

  it('hides while offline mode is off', () => {
    const { api } = stubApi({ offline_mode: false, tier2_auto_allow: [] });
    const { container } = render(
      <SentinelApiProvider api={api}>
        <OfflineIndicator />
      </SentinelApiProvider>,
    );
    // Offline off renders null from the first frame; the settings load keeps it off.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('SentinelSettings', () => {
  it('flips the offline mode switch and writes it through the API', async () => {
    const { api, updateUserSettings } = stubApi({ offline_mode: false, tier2_auto_allow: [] });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Offline mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(updateUserSettings).toHaveBeenCalledWith({ offline_mode: true });
    // The provider applies the updated settings, so the switch follows.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Offline mode' })).toBeChecked();
    });
  });
});
