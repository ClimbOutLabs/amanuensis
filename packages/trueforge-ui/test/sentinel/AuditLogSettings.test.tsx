// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ResolvedRoutesProvider } from '@/routing/ResolvedRoutesContext.js';
import { resolveRoutesConfig } from '@/routing/paths.js';
import { AuditLogSettings } from '@/sentinel/AuditLogSettings.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelUserAuditEntry, SentinelUserAuditPage } from '@/sentinel/types.js';

function makeEntry(overrides: Partial<SentinelUserAuditEntry>): SentinelUserAuditEntry {
  return {
    id: 'entry-1',
    session_id: 'chat-1',
    created_at: '2026-10-01T09:30:00.000Z',
    tier: 3,
    action_type: 'send_email',
    description: 'Sent an email to the plumber',
    outcome: 'approved',
    chat_exists: true,
    ...overrides,
  };
}

function stubApi(listUserAuditEntries: SentinelApi['listUserAuditEntries']): SentinelApi {
  return {
    listAuditEntries: vi.fn(async () => []),
    listUserAuditEntries,
    getUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
    })),
    updateUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
    })),
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
}

function renderPage(api: SentinelApi) {
  return render(
    <ResolvedRoutesProvider routes={resolveRoutesConfig()}>
      <SentinelApiProvider api={api}>
        <AuditLogSettings />
      </SentinelApiProvider>
    </ResolvedRoutesProvider>,
  );
}

describe('AuditLogSettings', () => {
  it('lists entries with outcome and tool, links live chats and marks deleted ones', async () => {
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(async () => ({
      entries: [
        makeEntry({ id: 'live', session_id: 'chat-live' }),
        makeEntry({
          id: 'gone',
          session_id: 'chat-gone',
          description: 'Refused to post to the forum',
          action_type: 'post_message',
          outcome: 'auto_denied',
          chat_exists: false,
        }),
      ],
    }));
    renderPage(stubApi(list));

    const live = (await screen.findByText('Sent an email to the plumber')).closest('li');
    const gone = screen.getByText('Refused to post to the forum').closest('li');
    if (live === null || gone === null) throw new Error('audit rows did not render as list items');

    expect(within(live).getByText('Approved')).toBeInTheDocument();
    expect(within(live).getByText('send_email')).toBeInTheDocument();
    expect(within(live).getByRole('link', { name: 'Open chat' }).getAttribute('href')).toContain('chat-live');
    expect(within(live).getByText(/2026/)).toBeInTheDocument();

    expect(within(gone).getByText('Refused')).toBeInTheDocument();
    expect(within(gone).getByText('Chat deleted')).toBeInTheDocument();
    expect(within(gone).queryByRole('link')).toBeNull();
  });

  it('loads the next page with the token and appends it', async () => {
    const pages: Record<string, SentinelUserAuditPage> = {
      first: { entries: [makeEntry({ id: 'a', description: 'First page entry' })], nextPageToken: 'page-2' },
      'page-2': { entries: [makeEntry({ id: 'b', description: 'Second page entry' })] },
    };
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(
      async ({ pageToken }) => pages[pageToken ?? 'first'] ?? { entries: [] },
    );
    renderPage(stubApi(list));

    await screen.findByText('First page entry');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second page entry')).toBeInTheDocument();
    expect(screen.getByText('First page entry')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: 'page-2' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('reloads from the first page when the outcome filter changes', async () => {
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(async ({ outcome }) => ({
      entries: [makeEntry({ id: outcome ?? 'all', description: `Showing ${outcome ?? 'everything'}` })],
    }));
    renderPage(stubApi(list));

    await screen.findByText('Showing everything');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'denied' } });

    expect(await screen.findByText('Showing denied')).toBeInTheDocument();
    expect(screen.queryByText('Showing everything')).toBeNull();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'denied', pageToken: undefined }));
  });
});
