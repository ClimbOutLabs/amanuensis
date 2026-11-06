import type { CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';
import { LIST_DEADLINE_MS, type GmailApiPort } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import type { GmailMessage } from '@truefoundry/trueforge-core/core/email/gmail/gmailWire';

import { gmailMailSource, googleCalendarSource } from '../../../../src/runtime/noticing/googleSources';
import { readMailWindow } from '../../../../src/runtime/noticing/watchers';

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
  function message({ id, thread, at }: { id: string; thread: string; at: Date }): GmailMessage {
    return {
      id,
      threadId: thread,
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

  /** An inbox that answers Gmail's `after:` and `before:` search in whole seconds and lists the newest first. */
  function gmail({ messages, perPage }: { messages: GmailMessage[]; perPage: number }) {
    const listMessages = jest.fn(({ query, pageToken }: { query: string; pageToken: string | undefined }) => {
      const after = Number(/after:(\d+)/.exec(query)?.[1]) * 1000;
      const before = Number(/before:(\d+)/.exec(query)?.[1]) * 1000;
      const matching = messages
        .filter(item => Number(item.internalDate) > after && Number(item.internalDate) < before)
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const start = pageToken === undefined ? 0 : Number(pageToken);
      return Promise.resolve({
        messageIds: matching.slice(start, start + perPage).map(item => item.id),
        nextPageToken: start + perPage < matching.length ? String(start + perPage) : undefined,
      });
    });
    const byId = (id: string) => {
      const found = messages.find(item => item.id === id);
      return found === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(found);
    };
    const api: Pick<GmailApiPort, 'listMessages' | 'getMessageHeaders' | 'getMessage' | 'getThread'> = {
      listMessages,
      getMessageHeaders: byId,
      getMessage: byId,
      getThread: () => Promise.reject(new Error('not used')),
    };
    return { api, listMessages };
  }

  it('pages through the inbox by message and hands back the oldest mail first', async () => {
    const messages = [3, 2, 1].map(n => message({ id: String(n), thread: `t-${String(n)}`, at: minute(50 + n) }));
    const { api, listMessages } = gmail({ messages, perPage: 1 });
    const read = await gmailMailSource(api).listNewMessages({ since: minute(0), before: NOW, limit: 10 });
    expect(listMessages).toHaveBeenCalledTimes(3);
    expect(read.read === 'all' ? read.messages.map(item => item.id) : read.read).toEqual(['1', '2', '3']);
  });

  it('says a window holds too much rather than reading part of it', async () => {
    const messages = [3, 2, 1].map(n => message({ id: String(n), thread: `t-${String(n)}`, at: minute(50 + n) }));
    const { api } = gmail({ messages, perPage: 100 });
    await expect(gmailMailSource(api).listNewMessages({ since: minute(0), before: NOW, limit: 2 })).resolves.toEqual({
      read: 'too_many',
    });
  });

  it('keeps the window exact to the millisecond though Gmail searches in seconds', async () => {
    const messages = [
      message({ id: 'before', thread: 'a', at: new Date(minute(10).getTime() - 1) }),
      message({ id: 'first', thread: 'b', at: minute(10) }),
      message({ id: 'last', thread: 'c', at: new Date(minute(20).getTime() - 1) }),
      message({ id: 'after', thread: 'd', at: minute(20) }),
    ];
    const { api } = gmail({ messages, perPage: 100 });
    const read = await gmailMailSource(api).listNewMessages({ since: minute(10), before: minute(20), limit: 10 });
    expect(read.read === 'all' ? read.messages.map(item => item.id) : read.read).toEqual(['first', 'last']);
  });

  it('reads a thread whose reply came after the cut, without passing over its first message', async () => {
    // Thread x has a bill at minute 1 and a reply at minute 10; thread y has one message at minute 5.
    const messages = [
      message({ id: 'x1', thread: 'x', at: minute(1) }),
      message({ id: 'y1', thread: 'y', at: minute(5) }),
      message({ id: 'x2', thread: 'x', at: minute(10) }),
    ];
    const { api } = gmail({ messages, perPage: 100 });
    const source = gmailMailSource(api);
    const seen: string[] = [];
    let since = minute(0);
    for (let pass = 0; pass < 5; pass += 1) {
      const read = await readMailWindow({ source, since, now: minute(30), limit: 1, logger: { warn: jest.fn() } });
      seen.push(...read.messages.map(item => item.id));
      if (read.resume_from === undefined) break;
      since = read.resume_from;
    }
    expect(seen).toEqual(['x1', 'y1', 'x2']);
  });

  it('hands back the oldest part when Gmail is too slow to read it all', async () => {
    jest.useFakeTimers();
    try {
      const messages = Array.from({ length: 8 }, (_, n) => message({ id: String(n), thread: 't', at: minute(n) }));
      const { api } = gmail({ messages, perPage: 100 });
      const slow: typeof api = {
        ...api,
        getMessageHeaders: id => (Number(id) >= 4 ? new Promise(() => undefined) : api.getMessageHeaders(id)),
      };
      const reading = gmailMailSource(slow).listNewMessages({ since: minute(0), before: NOW, limit: 50 });
      await jest.advanceTimersByTimeAsync(LIST_DEADLINE_MS + 1000);
      const read = await reading;
      expect(read.read).toBe('oldest');
      expect(read.read === 'oldest' ? read.messages.map(item => item.id) : []).toEqual(['0', '1', '2', '3']);
    } finally {
      jest.useRealTimers();
    }
  });
});
