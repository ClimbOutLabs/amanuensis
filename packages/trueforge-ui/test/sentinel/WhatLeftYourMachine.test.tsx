// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { formatBytes, NOTHING_LEFT_MESSAGE, WhatLeftYourMachine } from '@/sentinel/WhatLeftYourMachine.js';
import type { DataLocation, OutboundActivity, OutboundEvent, SentinelApi } from '@/sentinel/types.js';

const NOW = '2026-10-17T12:00:00.000Z';

function event(overrides: Partial<OutboundEvent> & Pick<OutboundEvent, 'id'>): OutboundEvent {
  return {
    kind: 'model_request',
    host: 'models.example.test',
    model: 'stub-model',
    tool_name: null,
    request_bytes: 2048,
    recipient_count: null,
    subject: null,
    conversation_id: 'chat-aaaaaa111111',
    created_at: NOW,
    ...overrides,
  };
}

const LOCATIONS: DataLocation[] = [
  {
    id: 'chats',
    name: 'Chats',
    where: 'Inside the database file /home/me/.local/share/aman/db.sqlite.',
    size_bytes: 5 * 1024 * 1024,
    size_covers: 'chats, personas and settings together',
  },
  {
    id: 'memory',
    name: 'Memory',
    where: 'In plain text files in the folder /home/me/memory.',
    size_bytes: 0,
    size_covers: null,
  },
  {
    id: 'backups',
    name: 'Backups',
    where: 'Aman makes no backups by itself.',
    size_bytes: null,
    size_covers: null,
  },
];

function stubApi(input: { activity?: OutboundActivity; locations?: DataLocation[]; fail?: Error }): SentinelApi {
  const reject = input.fail === undefined ? undefined : () => Promise.reject(input.fail);
  return {
    listAuditEntries: vi.fn(async () => []),
    getUserSettings: vi.fn(async () => ({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true })),
    updateUserSettings: vi.fn(),
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    listOutboundActivity:
      reject ?? vi.fn(async () => input.activity ?? { events: [], window_start: '', truncated: false }),
    listDataLocations: reject ?? vi.fn(async () => input.locations ?? LOCATIONS),
  };
}

function renderPage(api: SentinelApi) {
  return render(
    <SentinelApiProvider api={api}>
      <WhatLeftYourMachine />
    </SentinelApiProvider>,
  );
}

describe('formatBytes', () => {
  it('uses plain units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(120 * 1024 * 1024 * 1024)).toBe('120 GB');
  });
});

describe('WhatLeftYourMachine', () => {
  it('lists what Aman keeps with the real location and size, and says when a size is not measured', async () => {
    renderPage(stubApi({}));

    const chats = await waitFor(() => {
      const row = document.querySelector('[data-location="chats"]');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    expect(within(chats).getByText('Chats')).toBeInTheDocument();
    expect(within(chats).getByText(/\/home\/me\/\.local\/share\/aman\/db\.sqlite/)).toBeInTheDocument();
    expect(within(chats).getByText('5.0 MB')).toBeInTheDocument();
    expect(within(chats).getByText('Size covers chats, personas and settings together.')).toBeInTheDocument();
    expect(screen.getByText('0 B')).toBeInTheDocument();
    expect(screen.getByText('size not measured')).toBeInTheDocument();
    expect(screen.getByText('What Aman keeps, and where')).toBeInTheDocument();
  });

  it('says plainly that nothing left this computer when no request was recorded', async () => {
    renderPage(stubApi({}));

    expect(await screen.findByText(NOTHING_LEFT_MESSAGE)).toBeInTheDocument();
    expect(NOTHING_LEFT_MESSAGE).toBe('Nothing has left this computer in the last 24 hours.');
    expect(screen.getByText('What went out in the last 24 hours')).toBeInTheDocument();
  });

  it('shows one row per recorded request, newest first, with host, size and detail for each kind', async () => {
    const events: OutboundEvent[] = [
      event({
        id: 'e1',
        kind: 'email_sent',
        host: 'mail.example.test',
        model: null,
        tool_name: 'send_email',
        recipient_count: 3,
        subject: 'Quarterly numbers',
        request_bytes: 900,
        conversation_id: 'c',
      }),
      event({
        id: 'e2',
        kind: 'web_search',
        host: 'search.example.test',
        model: null,
        tool_name: 'lookup',
        request_bytes: 64,
      }),
      event({
        id: 'e3',
        kind: 'map_lookup',
        host: 'maps.example.test',
        model: null,
        request_bytes: null,
        conversation_id: null,
      }),
      event({
        id: 'e4',
        kind: 'connector_call',
        host: 'svc.example.test',
        model: null,
        tool_name: 'list_things',
        request_bytes: 20,
      }),
      event({ id: 'e5' }),
    ];
    renderPage(stubApi({ activity: { events, window_start: NOW, truncated: false } }));

    await screen.findByText(/Email sent to/);
    const rows = Array.from(document.querySelectorAll('[data-kind]'));
    expect(rows.map(row => row.getAttribute('data-kind'))).toEqual([
      'email_sent',
      'web_search',
      'map_lookup',
      'connector_call',
      'model_request',
    ]);
    expect(screen.getByText('mail.example.test')).toBeInTheDocument();
    expect(screen.getByText(/3 recipients · subject "Quarterly numbers" · 900 B sent/)).toBeInTheDocument();
    expect(screen.getByText(/lookup · 64 B sent/)).toBeInTheDocument();
    expect(screen.getByText('maps.example.test')).toBeInTheDocument();
    expect(screen.getByText(/list_things · 20 B sent/)).toBeInTheDocument();
    expect(screen.getByText(/stub-model · 2\.0 KB sent · chat \.\.\.111111/)).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_LEFT_MESSAGE)).not.toBeInTheDocument();
  });

  it('shows the day for a request from before today and only the time for one from today', async () => {
    const events = [
      event({ id: 'today', host: 'today.example.test', created_at: new Date().toISOString() }),
      event({ id: 'old', host: 'old.example.test', created_at: '2020-01-05T10:00:00.000Z' }),
    ];
    renderPage(stubApi({ activity: { events, window_start: NOW, truncated: false } }));

    await screen.findByText('today.example.test');
    const timeOf = (host: string) =>
      screen.getByText(host).closest('[data-kind]')?.querySelector('time')?.textContent ?? '';
    expect(timeOf('old.example.test')).toMatch(/Jan\s+\d+,/);
    expect(timeOf('today.example.test')).not.toMatch(/[A-Z][a-z]{2}\s+\d+,/);
    expect(timeOf('today.example.test')).toMatch(/\d:\d{2}:\d{2}/);
  });

  it('says so when an email call names no recipients, rather than guessing a count', async () => {
    const events = [
      event({
        id: 'e1',
        kind: 'email_sent',
        host: 'mail.example.test',
        model: null,
        tool_name: 'send_draft',
        recipient_count: null,
        request_bytes: 30,
      }),
    ];
    renderPage(stubApi({ activity: { events, window_start: NOW, truncated: false } }));

    expect(await screen.findByText(/recipients not listed in the call/)).toBeInTheDocument();
  });

  it('folds repeated model requests into one row per chat once the list is long', async () => {
    const events: OutboundEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      events.push(
        event({
          id: `a${String(i)}`,
          conversation_id: 'chat-aaaaaa111111',
          created_at: `2026-10-17T11:${String(10 + i)}:00.000Z`,
        }),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      events.push(
        event({
          id: `b${String(i)}`,
          conversation_id: 'chat-bbbbbb222222',
          created_at: `2026-10-17T10:${String(10 + i)}:00.000Z`,
        }),
      );
    }
    events.push(
      event({
        id: 'mail',
        kind: 'email_sent',
        host: 'mail.example.test',
        model: null,
        tool_name: 'send_email',
        recipient_count: 1,
        subject: 'Hi',
      }),
    );
    renderPage(stubApi({ activity: { events, window_start: NOW, truncated: false } }));

    await screen.findByText('20 model requests to', { exact: false });
    const grouped = Array.from(document.querySelectorAll('[data-grouped="true"]'));
    expect(grouped).toHaveLength(2);
    expect(within(grouped[0] as HTMLElement).getByText(/40 KB sent in all · chat \.\.\.111111/)).toBeInTheDocument();
    expect(within(grouped[1] as HTMLElement).getByText(/10 model requests to/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-kind="email_sent"]')).toHaveLength(1);
  });

  it('says when older requests in the window are not shown', async () => {
    renderPage(stubApi({ activity: { events: [event({ id: 'e1' })], window_start: NOW, truncated: true } }));

    expect(await screen.findByText(/Older requests in this window are not shown\./)).toBeInTheDocument();
  });

  it('shows the server message, such as the owner-only notice, instead of any list', async () => {
    renderPage(stubApi({ fail: new Error('Only the owner of this computer can see this page.') }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner of this computer can see this page.');
    expect(screen.queryByText(NOTHING_LEFT_MESSAGE)).not.toBeInTheDocument();
  });

  it('never shows request text: only hosts, models, tools, sizes and the email subject are drawn', async () => {
    const events = [
      event({ id: 'e1', kind: 'web_search', host: 'search.example.test', model: null, tool_name: 'lookup' }),
    ];
    const { container } = renderPage(stubApi({ activity: { events, window_start: NOW, truncated: false } }));
    await screen.findByText(/Web search to/);

    expect(container.textContent).not.toMatch(/prompt|query text|api key/i);
  });
});
