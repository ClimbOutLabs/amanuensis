import type { CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';
import type { GmailApiPort } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import type { GmailMessage, GmailThread } from '@truefoundry/trueforge-core/core/email/gmail/gmailWire';

import { gmailMailSource, googleCalendarSource } from '../../../../src/runtime/noticing/googleSources';

const NOW = new Date('2026-11-05T15:00:00.000Z');

describe('Google Calendar source', () => {
  const timed = (id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id,
    summary: id,
    start: { dateTime: '2026-11-05T16:00:00.000Z' },
    end: { dateTime: '2026-11-05T17:00:00.000Z' },
    ...extra,
  });
  const me = { email: 'me@example.com', self: true };
  const stranger = { email: 'stranger@example.com' };

  function sourceOf(events: CalendarEvent[]) {
    const api: Pick<CalendarApiPort, 'listEvents'> = {
      listEvents: () => Promise.resolve({ events, nextPageToken: undefined }),
    };
    return googleCalendarSource({ api, timeZone: 'UTC' });
  }

  it('leaves out cancelled, declined and all-day events', async () => {
    const events = await sourceOf([
      timed('on', { organizer: me }),
      timed('cancelled', { status: 'cancelled', organizer: me }),
      timed('declined', { organizer: stranger, attendees: [{ ...me, responseStatus: 'declined' }] }),
      { id: 'all-day', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } },
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => item.id)).toEqual(['on']);
  });

  it('counts an event as the person’s own only when they organised or accepted it', async () => {
    const events = await sourceOf([
      timed('organised', { organizer: me, attendees: [{ ...stranger, responseStatus: 'needsAction' }] }),
      timed('accepted', { organizer: stranger, attendees: [{ ...me, responseStatus: 'accepted' }] }),
      timed('invite', { organizer: stranger, attendees: [{ ...me, responseStatus: 'needsAction' }] }),
      timed('maybe', { organizer: stranger, attendees: [{ ...me, responseStatus: 'tentative' }] }),
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => [item.id, item.own])).toEqual([
      ['organised', true],
      ['accepted', true],
      ['invite', false],
      ['maybe', false],
    ]);
  });
});

describe('Gmail source', () => {
  const minute = (value: number) => new Date(Date.UTC(2026, 10, 5, 14, value));
  function message(id: string, at: Date): GmailMessage {
    return {
      id,
      threadId: `t-${id}`,
      labelIds: ['INBOX'],
      internalDate: String(at.getTime()),
      snippet: '',
      payload: {
        headers: [
          { name: 'From', value: 'Dana <dana@example.com>' },
          { name: 'Subject', value: `Mail ${id}` },
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=example.com' },
        ],
      },
    };
  }

  /** Threads newest first, as Gmail lists them, split into pages of `perPage`. */
  function gmail({ threads, perPage }: { threads: GmailThread[]; perPage: number }) {
    const listThreads = jest.fn(({ pageToken }: { pageToken: string | undefined }) => {
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const page = threads.slice(start, start + perPage);
      return Promise.resolve({
        threadIds: page.map(thread => thread.id),
        nextPageToken: start + perPage < threads.length ? String(start + perPage) : undefined,
        resultSizeEstimate: threads.length,
      });
    });
    const api: Pick<GmailApiPort, 'listThreads' | 'getThread' | 'getMessage'> = {
      listThreads,
      getThread: ({ threadId }) => {
        const found = threads.find(thread => thread.id === threadId);
        return found === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(found);
      },
      getMessage: () => Promise.reject(new Error('not used')),
    };
    return { api, listThreads };
  }

  it('pages through the inbox and hands back the oldest mail first', async () => {
    const threads = [3, 2, 1].map(n => ({ id: `t-${String(n)}`, messages: [message(String(n), minute(50 + n))] }));
    const { api, listThreads } = gmail({ threads, perPage: 1 });
    const { messages, truncated } = await gmailMailSource(api).listNewMessages({ since: minute(0), limit: 10 });
    expect(listThreads).toHaveBeenCalledTimes(3);
    expect(messages.map(item => item.id)).toEqual(['1', '2', '3']);
    expect(truncated).toBe(false);
  });

  it('says there is more when one read cannot hold it all, keeping the oldest', async () => {
    const threads = [3, 2, 1].map(n => ({ id: `t-${String(n)}`, messages: [message(String(n), minute(50 + n))] }));
    const { api } = gmail({ threads, perPage: 100 });
    const { messages, truncated } = await gmailMailSource(api).listNewMessages({ since: minute(0), limit: 2 });
    expect(messages.map(item => item.id)).toEqual(['1', '2']);
    expect(truncated).toBe(true);
  });
});
