// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelSettings } from '@/sentinel/SentinelSettings.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';

function stubApi(): { api: SentinelApi; updateUserSettings: ReturnType<typeof vi.fn> } {
  const updateUserSettings = vi.fn(async (patch: Partial<SentinelUserSettings>) => ({
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: true,
    maps_without_asking: false,
    sandbox_without_asking: true,
    package_downloads_without_project_allowed: false,
    ...patch,
  }));
  const api: SentinelApi = {
    listAuditEntries: vi.fn(async () => []),
    listBriefItemCompletions: async () => [],
    markBriefItemDone: async () => undefined,
    unmarkBriefItemDone: async () => undefined,
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      package_downloads_without_project_allowed: false,
    })),
    updateUserSettings,
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  return { api, updateUserSettings };
}

describe('SentinelSettings Always allow', () => {
  it('renders an Always allow toggle for each Tier 2 kind, off by default', async () => {
    const { api, updateUserSettings } = stubApi();
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: file_write' });
    await waitFor(() => {
      expect(fileToggle).toBeEnabled();
    });
    expect(fileToggle).not.toBeChecked();
    // Only kinds the classifier can ask about get a toggle.
    expect(screen.queryByRole('switch', { name: /shell|runner|branch/ })).not.toBeInTheDocument();
    fireEvent.click(fileToggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ tier2_auto_allow: ['file_write'] });
    });
    // The saved settings come back through the provider, so the switch follows them.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Always allow: file_write' })).toBeChecked();
    });
  });

  it('switches a relaxed kind back off and saves the empty list', async () => {
    const { api, updateUserSettings } = stubApi();
    api.getUserSettings = vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: ['file_write'] as Array<'file_write'>,
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      package_downloads_without_project_allowed: false,
    }));
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: file_write' });
    await waitFor(() => {
      expect(fileToggle).toBeChecked();
    });
    fireEvent.click(fileToggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ tier2_auto_allow: [] });
    });
  });

  it('reflects the server-side relaxed kinds', async () => {
    const { api } = stubApi();
    api.getUserSettings = vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: ['file_write'] as Array<'file_write'>,
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      package_downloads_without_project_allowed: false,
    }));
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: file_write' });
    await waitFor(() => {
      expect(fileToggle).toBeChecked();
    });
  });
});
