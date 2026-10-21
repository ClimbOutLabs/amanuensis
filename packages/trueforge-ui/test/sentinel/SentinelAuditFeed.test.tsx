// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelAuditFeed } from '@/sentinel/SentinelAuditFeed.js';
import type { SentinelApi, SentinelAuditEntry, SentinelUserSettings } from '@/sentinel/types.js';

function makeEntry(overrides: Partial<SentinelAuditEntry>): SentinelAuditEntry {
  return {
    id: 'entry-1',
    session_id: 'session-1',
    created_at: '2026-09-29T10:00:00.000Z',
    tier: 2,
    action_type: 'exec',
    description: 'Wrote 3 files in src/',
    outcome: 'ran',
    ...overrides,
  };
}

function stubApi(entries: SentinelAuditEntry[]): { api: SentinelApi; updateUserSettings: ReturnType<typeof vi.fn> } {
  const updateUserSettings = vi.fn(async (patch: Partial<SentinelUserSettings>) => ({
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: true,
    maps_without_asking: false,
    ...patch,
  }));
  const api: SentinelApi = {
    listAuditEntries: vi.fn(async () => entries),
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
    })),
    updateUserSettings,
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  return { api, updateUserSettings };
}

describe('SentinelAuditFeed', () => {
  it('renders entries with descriptions, outcomes, and denial reasons', async () => {
    const { api } = stubApi([
      makeEntry({
        id: 'entry-1',
        outcome: 'approved',
        description: 'Sent $250 to Acme Corp',
        tier: 3,
        action_type: 'payment_send',
      }),
      makeEntry({
        id: 'entry-2',
        outcome: 'denied',
        description: 'Published the release',
        reason: 'User declined.',
        tier: 3,
        action_type: 'deploy_publish',
      }),
      makeEntry({
        id: 'entry-3',
        outcome: 'auto_denied',
        description: 'Refreshed the database',
        reason: 'Offline mode was on.',
        tier: 3,
        action_type: 'db_refresh',
      }),
      makeEntry({ id: 'entry-4', outcome: 'ran', description: 'Wrote a file', tier: 2, action_type: 'exec' }),
      makeEntry({
        id: 'entry-5',
        outcome: 'logged',
        description: 'Read the credentials file',
        tier: 1,
        action_type: 'file_read',
      }),
    ]);
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    expect(await screen.findByText('Sent $250 to Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === ' · User declined.')).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === ' · Offline mode was on.')).toBeInTheDocument();
    expect(screen.getByText('Ran')).toBeInTheDocument();
    expect(screen.getByText('Held or noted')).toBeInTheDocument();
  });

  it('renders an Always allow toggle for each Tier 2 kind, off by default', async () => {
    const { api, updateUserSettings } = stubApi([makeEntry({ id: 'entry-1' })]);
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: Write files' });
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
      expect(screen.getByRole('switch', { name: 'Always allow: Write files' })).toBeChecked();
    });
  });

  it('switches a relaxed kind back off and saves the empty list', async () => {
    const { api, updateUserSettings } = stubApi([]);
    api.getUserSettings = vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: ['file_write'] as Array<'file_write'>,
      search_without_asking: true,
      maps_without_asking: false,
    }));
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: Write files' });
    await waitFor(() => {
      expect(fileToggle).toBeChecked();
    });
    fireEvent.click(fileToggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ tier2_auto_allow: [] });
    });
  });

  it('reflects the server-side relaxed kinds', async () => {
    const { api } = stubApi([makeEntry({ id: 'entry-1' })]);
    api.getUserSettings = vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: ['file_write'] as Array<'file_write'>,
      search_without_asking: true,
      maps_without_asking: false,
    }));
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    const fileToggle = await screen.findByRole('switch', { name: 'Always allow: Write files' });
    await waitFor(() => {
      expect(fileToggle).toBeChecked();
    });
  });

  it('separates the Always allow rules from Recent actions, with plain labels and reasons', async () => {
    const { api } = stubApi([
      makeEntry({
        id: 'entry-1',
        outcome: 'auto_denied',
        description: 'Sent a search',
        reason: 'outbound_guard',
        tier: 3,
        action_type: 'web_search',
      }),
      makeEntry({ id: 'entry-2', outcome: 'ran', description: 'Wrote a file', tier: 2, action_type: 'file_write' }),
    ]);
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    expect((await screen.findAllByText('Always allow')).length).toBeGreaterThan(0);
    expect(screen.getByText('Recent actions')).toBeInTheDocument();
    expect(screen.queryByText('Tier 2 actions')).not.toBeInTheDocument();
    // The kind shows its plain label, never the tool id, and the refusal reason is in plain words.
    expect(screen.getAllByText('Write files').length).toBeGreaterThan(0);
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
    expect(screen.queryByText('file_write')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === ' · it carries something that must not leave this computer',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/outbound_guard/)).not.toBeInTheDocument();
  });

  it('shows the empty state when the session has no permission activity', async () => {
    const { api } = stubApi([]);
    render(
      <SentinelApiProvider api={api}>
        <SentinelAuditFeed sessionId="session-1" />
      </SentinelApiProvider>,
    );
    expect(await screen.findByText('No permission activity in this session yet.')).toBeInTheDocument();
  });
});
