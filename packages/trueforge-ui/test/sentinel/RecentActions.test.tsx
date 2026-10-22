// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RecentActions } from '@/sentinel/RecentActions.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelAuditEntry } from '@/sentinel/types.js';

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

function stubApi(entries: SentinelAuditEntry[]): SentinelApi {
  return {
    listAuditEntries: vi.fn(async () => entries),
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    })),
    updateUserSettings: vi.fn(async () => ({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    })),
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
}

function renderActions(entries: SentinelAuditEntry[]) {
  render(
    <SentinelApiProvider api={stubApi(entries)}>
      <RecentActions sessionId="session-1" open onToggle={vi.fn()} />
    </SentinelApiProvider>,
  );
}

describe('RecentActions', () => {
  it('shows each state in plain words, one per row, and never the raw tool name or the description', async () => {
    renderActions([
      makeEntry({ id: 'entry-1', action_type: 'gmail_send', outcome: 'approved', tier: 3, description: 'Sent to Rui' }),
      makeEntry({ id: 'entry-2', action_type: 'exec', outcome: 'denied', tier: 3 }),
      makeEntry({ id: 'entry-3', action_type: 'web_search', outcome: 'auto_denied', tier: 3 }),
      makeEntry({ id: 'entry-4', action_type: 'write_file', outcome: 'ran', tier: 2 }),
      makeEntry({ id: 'entry-5', action_type: 'exec', outcome: 'logged', tier: 2 }),
    ]);
    expect(await screen.findByText('Gmail · sent an email')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 5' }));
    expect(screen.getByText('You approved')).toBeInTheDocument();
    expect(screen.getByText('You declined')).toBeInTheDocument();
    expect(screen.getByText('Failed: blocked by your settings')).toBeInTheDocument();
    expect(screen.getByText('Done · allowed by your settings')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
    expect(screen.queryByText('gmail_send')).not.toBeInTheDocument();
    expect(screen.queryByText('Sent to Rui')).not.toBeInTheDocument();
  });

  it('uses the tool name in sentence case for a tool the table does not know', async () => {
    renderActions([makeEntry({ id: 'entry-1', action_type: 'mystery_tool', outcome: 'ran' })]);
    expect(await screen.findByText('Mystery tool')).toBeInTheDocument();
    expect(screen.queryByText('mystery_tool')).not.toBeInTheDocument();
  });

  it('shows four rows and a Show all control with the entry count for the rest', async () => {
    const entries = ['gmail_read', 'calendar_read', 'web_search', 'exec', 'write_file', 'space_read'].map(
      (action, index) =>
        makeEntry({
          id: `entry-${index}`,
          action_type: action,
          outcome: 'ran',
          created_at: `2026-09-29T10:0${index}:00.000Z`,
        }),
    );
    renderActions(entries);
    expect(await screen.findByText('Spaces · read a space')).toBeInTheDocument();
    expect(screen.queryByText('Gmail · read email')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }));
    expect(screen.getByText('Gmail · read email')).toBeInTheDocument();
  });

  it('shows the empty line when the session has no permission activity', async () => {
    renderActions([]);
    expect(await screen.findByText('Nothing has happened in this chat yet.')).toBeInTheDocument();
  });
});
