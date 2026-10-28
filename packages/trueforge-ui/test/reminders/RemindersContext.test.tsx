// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemindersMarker } from '@/atoms/lib/sessionReminders.js';
import { ThreadListRow } from '@/atoms/ThreadListRow.js';
import { ReminderNotificationPrompt } from '@/reminders/ReminderNotificationPrompt.js';
import { RemindersProvider, useOptionalReminders } from '@/reminders/RemindersContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentUIServer, ListResult, ListSessionsParams, Session } from '@/server/types.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';

import { createMockAgentUIServer } from '../server/mockServer.js';

const POLL_MS = 1_000;
const REMINDERS_ID = 'reminders-chat';

function remindersSession({ text, at }: { text: string; at: string }) {
  return {
    id: REMINDERS_ID,
    reminders: { latestText: text, latestAt: at },
  };
}

/** A server whose Reminders chat can be changed between polls. */
function makeServer(initial: ReturnType<typeof remindersSession> | null) {
  const state = { reminders: initial };
  const otherChat = { id: 'chat-1' };
  const getSession = vi.fn(() => Promise.resolve(state.reminders ?? otherChat));
  const listSessions = vi.fn(() =>
    Promise.resolve({ data: state.reminders === null ? [otherChat] : [otherChat, state.reminders] }),
  );
  const server = {
    getCapabilities: () => Promise.resolve({ data: {} }),
    getSession,
    listSessions,
  } as unknown as AgentUIServer;
  return { server, state, listSessions, getSession };
}

/** A stand-in for the browser's Notification, recording what it was asked to show. */
function stubNotification(permission: NotificationPermission) {
  const shown: string[] = [];
  const requestPermission = vi.fn(() => {
    FakeNotification.permission = 'granted';
    return Promise.resolve<NotificationPermission>('granted');
  });
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    constructor(title: string) {
      shown.push(title);
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, requestPermission };
}

function Probe() {
  const reminders = useOptionalReminders();
  return (
    <div>
      <span data-testid="unread">{String(reminders?.unread)}</span>
      <span data-testid="session">{reminders?.remindersSessionId ?? 'none'}</span>
      <button type="button" onClick={reminders?.markSeen}>
        open reminders
      </button>
      <button type="button" onClick={reminders?.reminderSet}>
        reminder set
      </button>
      <ReminderNotificationPrompt />
    </div>
  );
}

function renderProvider(server: AgentUIServer) {
  return render(
    <SlotsProvider>
      <ServerProvider server={server}>
        <RemindersProvider pollMs={POLL_MS}>
          <Probe />
        </RemindersProvider>
      </ServerProvider>
    </SlotsProvider>,
  );
}

async function tick(ms = POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('Reminders notifications and unread mark', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks about notices once, with a plain explanation, and shows one when a reminder is due', async () => {
    const { shown, requestPermission } = stubNotification('default');
    const { server, state } = makeServer(null);
    renderProvider(server);
    await tick(0);
    expect(requestPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('reminder set'));
    await tick(0);
    expect(screen.getByText(/Want a pop-up when a reminder is due\?/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on notices' }));
      await Promise.resolve();
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Want a pop-up/)).not.toBeInTheDocument();

    // The reminder comes due: the host wrote it into the Reminders chat.
    vi.setSystemTime(new Date('2026-10-26T12:05:00.000Z'));
    state.reminders = remindersSession({ text: 'Take the medicine', at: '2026-10-26T12:05:00.000Z' });
    await tick();
    expect(shown).toEqual(['Reminder: Take the medicine']);
    expect(screen.getByTestId('unread')).toHaveTextContent('true');

    // Polling again does not announce the same reminder twice, and nothing asks again.
    await tick();
    await tick();
    expect(shown).toHaveLength(1);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('never asks again once the person has answered, even after a reload', async () => {
    stubNotification('default');
    const { server } = makeServer(null);
    const first = renderProvider(server);
    fireEvent.click(screen.getByText('reminder set'));
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/Want a pop-up/)).not.toBeInTheDocument();
    first.unmount();

    renderProvider(server);
    await tick(0);
    expect(screen.queryByText(/Want a pop-up/)).not.toBeInTheDocument();
  });

  it('still marks the chat unread when notices were turned down, and shows no notice', async () => {
    const { shown } = stubNotification('denied');
    const { server, state } = makeServer(null);
    renderProvider(server);
    await tick(0);
    expect(screen.queryByText(/Want a pop-up/)).not.toBeInTheDocument();

    state.reminders = remindersSession({ text: 'Call the dentist', at: '2026-10-26T12:05:00.000Z' });
    fireEvent.click(screen.getByText('reminder set'));
    await tick(0);
    expect(screen.getByTestId('session')).toHaveTextContent(REMINDERS_ID);
    expect(screen.getByTestId('unread')).toHaveTextContent('true');
    expect(shown).toEqual([]);
  });

  it('clears the unread mark when the Reminders chat is opened, and keeps it cleared', async () => {
    stubNotification('denied');
    const { server } = makeServer(remindersSession({ text: 'Call the dentist', at: '2026-10-26T12:05:00.000Z' }));
    const first = renderProvider(server);
    await tick(0);
    expect(screen.getByTestId('unread')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('open reminders'));
    expect(screen.getByTestId('unread')).toHaveTextContent('false');
    first.unmount();

    renderProvider(server);
    await tick(0);
    expect(screen.getByTestId('unread')).toHaveTextContent('false');
  });

  it('finds the Reminders chat past the first page without asking for a page the API refuses', async () => {
    stubNotification('denied');
    // The sessions API serves at most 25 chats per page and refuses a larger
    // ask, the way the real API answers a limit past its maximum.
    const total = 60;
    const remindersIndex = 40;
    const remindersEntry: Session & { reminders: RemindersMarker } = {
      id: REMINDERS_ID,
      isMutable: false,
      createdAt: '2026-10-26T12:00:00.000Z',
      updatedAt: '2026-10-26T12:00:00.000Z',
      reminders: { latestText: 'Call the dentist', latestAt: '2026-10-26T12:05:00.000Z' },
    };
    const sessions: Session[] = Array.from({ length: total }, (_, index) =>
      index === remindersIndex
        ? remindersEntry
        : {
            id: `chat-${String(index)}`,
            isMutable: false,
            createdAt: '2026-10-26T12:00:00.000Z',
            updatedAt: '2026-10-26T12:00:00.000Z',
          },
    );
    const requests: ListSessionsParams[] = [];
    const listSessions = (request: ListSessionsParams = {}): Promise<ListResult<Session>> => {
      requests.push(request);
      const limit = request.limit ?? sessions.length;
      if (limit > 25) return Promise.reject(new Error('page size refused'));
      const start = request.pageToken === undefined ? 0 : Number(request.pageToken);
      const data = sessions.slice(start, start + limit);
      const next = start + limit;
      return Promise.resolve(next < sessions.length ? { data, nextPageToken: String(next) } : { data });
    };
    const server = createMockAgentUIServer({
      getSession: () => Promise.resolve(remindersEntry),
      listSessions,
    });

    renderProvider(server);
    await tick(0);

    expect(screen.getByTestId('session')).toHaveTextContent(REMINDERS_ID);
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(request.limit).toBeLessThanOrEqual(25);
    }
  });

  it('draws the unread mark on the chat list row', () => {
    const { rerender } = render(
      <SlotsProvider>
        <ThreadListRow title="Reminders" active={false} onSelect={() => {}} unread />
      </SlotsProvider>,
    );
    expect(screen.getByRole('img', { name: 'New reminder' })).toBeInTheDocument();
    rerender(
      <SlotsProvider>
        <ThreadListRow title="Reminders" active={false} onSelect={() => {}} />
      </SlotsProvider>,
    );
    expect(screen.queryByRole('img', { name: 'New reminder' })).not.toBeInTheDocument();
  });
});
