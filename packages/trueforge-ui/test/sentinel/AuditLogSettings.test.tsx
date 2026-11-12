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
    action_type: 'gmail_send',
    description: 'Sent an email to the plumber',
    outcome: 'approved',
    chat_exists: true,
    ...overrides,
  };
}

function stubApi(listUserAuditEntries: SentinelApi['listUserAuditEntries']): SentinelApi {
  return {
    listAuditEntries: vi.fn(async () => []),
    listBriefItemCompletions: async () => [],
    markBriefItemDone: async () => undefined,
    unmarkBriefItemDone: async () => undefined,
    listUserAuditEntries,
    getUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      chat_search_enabled: false,
      package_downloads_without_project_allowed: false,
    })),
    updateUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      chat_search_enabled: false,
      package_downloads_without_project_allowed: false,
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
    expect(within(live).getByText('Sent an email')).toBeInTheDocument();
    expect(within(live).queryByText('gmail_send')).not.toBeInTheDocument();
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

  it('sends the picked dates as the start of the first day and the start of the day after the last', async () => {
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(async () => ({ entries: [makeEntry({})] }));
    renderPage(stubApi(list));

    await screen.findByText('Sent an email to the plumber');
    const first = list.mock.calls[0]?.[0];
    expect(first?.from).toBeUndefined();
    expect(first?.to).toBeUndefined();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-03' } });

    await waitFor(() => {
      const last = list.mock.calls.at(-1)?.[0];
      expect(last?.from).toBe(new Date(2026, 9, 1).toISOString());
      expect(last?.to).toBe(new Date(2026, 9, 4).toISOString());
    });
  });

  it('keeps entries from the first moment of the From day to the last moment of the To day', async () => {
    const all = [
      makeEntry({
        id: 'before',
        description: 'Just before the From day',
        created_at: new Date(2026, 8, 30, 23, 59, 59, 999).toISOString(),
      }),
      makeEntry({
        id: 'first-moment',
        description: 'First moment of the From day',
        created_at: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(),
      }),
      makeEntry({
        id: 'last-moment',
        description: 'Last moment of the To day',
        created_at: new Date(2026, 9, 3, 23, 59, 59, 999).toISOString(),
      }),
      makeEntry({
        id: 'after',
        description: 'First moment after the To day',
        created_at: new Date(2026, 9, 4, 0, 0, 0, 0).toISOString(),
      }),
    ];
    // The stub narrows like the server does: at or after from, before to.
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(async ({ from, to }) => ({
      entries: all.filter(
        entry => (from === undefined || entry.created_at >= from) && (to === undefined || entry.created_at < to),
      ),
    }));
    renderPage(stubApi(list));

    await screen.findByText('Just before the From day');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-03' } });

    await screen.findByText('First moment of the From day');
    expect(screen.getByText('Last moment of the To day')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Just before the From day')).toBeNull();
      expect(screen.queryByText('First moment after the To day')).toBeNull();
    });
  });

  it('names the dates when the filter leaves nothing, and clearing shows everything again', async () => {
    const list = vi.fn<SentinelApi['listUserAuditEntries']>(async ({ from }) => ({
      entries: from === undefined ? [makeEntry({})] : [],
    }));
    renderPage(stubApi(list));

    await screen.findByText('Sent an email to the plumber');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });

    expect(await screen.findByText('Nothing in the audit log for those dates.')).toBeInTheDocument();
    const clearButtons = screen.getAllByRole('button', { name: 'Clear dates' });
    const clear = clearButtons[0];
    if (clear === undefined) throw new Error('no Clear dates button rendered');
    fireEvent.click(clear);

    expect(await screen.findByText('Sent an email to the plumber')).toBeInTheDocument();
    await waitFor(() => {
      const last = list.mock.calls.at(-1)?.[0];
      expect(last?.from).toBeUndefined();
      expect(last?.to).toBeUndefined();
    });
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
