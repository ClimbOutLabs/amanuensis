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
    listBriefItemCompletions: async () => [],
    markBriefItemDone: async () => undefined,
    unmarkBriefItemDone: async () => undefined,
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings,
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  return { api, updateUserSettings };
}

describe('OfflineIndicator', () => {
  it('shows while the server settings say offline mode is on', async () => {
    const { api } = stubApi({
      offline_mode: true,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <OfflineIndicator />
      </SentinelApiProvider>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Offline mode');
  });

  it('keeps a short reminder in compact form', async () => {
    const { api } = stubApi({
      offline_mode: true,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <OfflineIndicator compact />
      </SentinelApiProvider>,
    );
    const status = await screen.findByRole('status', { name: 'Offline mode is on' });
    expect(status).not.toHaveTextContent('Offline mode');
  });

  it('hides while offline mode is off', () => {
    const { api } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
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
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Offline mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ offline_mode: true });
    });
    // The provider applies the updated settings, so the switch follows.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Offline mode' })).toBeChecked();
    });
  });

  it('shows searches running without asking by default, and switches them back to Ask', async () => {
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Run web searches without asking' });
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(screen.getByText(/Run without asking\./)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ search_without_asking: false });
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Run web searches without asking' })).not.toBeChecked();
    });
    expect(screen.getByText(/Every web search shows an approval card/)).toBeInTheDocument();
  });

  it.each([true, false])(
    'says what the search service sees, whether searches run without asking (%s) or ask',
    async on => {
      const { api } = stubApi({
        offline_mode: false,
        tier2_auto_allow: [],
        search_without_asking: on,
        maps_without_asking: false,
        sandbox_without_asking: true,
      });
      render(
        <SentinelApiProvider api={api}>
          <SentinelSettings />
        </SentinelApiProvider>,
      );
      expect(
        await screen.findByText(
          "Searches go to Parallel, which sees the search words and this instance's internet address. To stop searching, remove the parallel-web connector or turn on Offline mode.",
        ),
      ).toBeInTheDocument();
    },
  );

  it('reports a failed search setting save beside the switch', async () => {
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    updateUserSettings.mockRejectedValueOnce(new Error('Save failed.'));
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    fireEvent.click(await screen.findByRole('switch', { name: 'Run web searches without asking' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed.');
  });

  it('shows maps asking by default, and switches them to run without asking', async () => {
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Show maps without asking' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Maps ask before each one.')).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ maps_without_asking: true });
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Show maps without asking' })).toBeChecked();
    });
    expect(
      screen.getByText(
        'Maps run without asking. After this chat reads your email or calendar, a map asks instead if it would share a name, email address or number from them.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failed maps save beside the switch', async () => {
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    updateUserSettings.mockRejectedValueOnce(new Error('Save failed.'));
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    fireEvent.click(await screen.findByRole('switch', { name: 'Show maps without asking' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed.');
  });

  it('shows the sandbox switch on by default, and turning it off saves the choice', async () => {
    const { api, updateUserSettings } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Run code in the sandbox without asking' });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(
        'Aman can make new files and run the scripts it wrote in this chat without asking. Changing a file that already exists, running scripts from your repository, and running tests still ask. Anything that leaves the sandbox still asks.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ sandbox_without_asking: false });
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Run code in the sandbox without asking' })).not.toBeChecked();
    });
  });

  it('renders the sandbox switch unchecked when the server says it asks', async () => {
    const { api } = stubApi({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: false,
    });
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    expect(await screen.findByRole('switch', { name: 'Run code in the sandbox without asking' })).not.toBeChecked();
    expect(screen.getByText('Work inside the sandbox asks before it runs.')).toBeInTheDocument();
  });
});
