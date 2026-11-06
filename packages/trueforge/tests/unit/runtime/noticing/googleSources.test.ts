import type { CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';
import { LIST_DEADLINE_MS, type GmailApiPort } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import type { GmailMessage } from '@truefoundry/trueforge-core/core/email/gmail/gmailWire';

import { GoogleApiError } from '@truefoundry/trueforge-core/core/google/errors';
import { GOOGLE_TOKEN_URL } from '@truefoundry/trueforge-core/core/google/oauth';
import { z } from 'zod';

import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteGoogleConnectionStore } from '../../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import {
  gmailMailSource,
  googleCalendarSource,
  googleCalendarTimezoneFor,
} from '../../../../src/runtime/noticing/googleSources';
import { MessageUnreadableError } from '../../../../src/runtime/noticing/sources';
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
      timed('organised', {
        organizer: me,
        creator: me,
        attendees: [{ ...stranger, responseStatus: 'needsAction' }],
      }),
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

  it('does not count an invite from outside that names the person as its organizer', async () => {
    // Google adds such an invite with the person as organizer and accepted, and the sender as its creator.
    const events = await sourceOf([
      timed('spoofed', {
        organizer: me,
        creator: stranger,
        attendees: [
          { ...me, organizer: true, responseStatus: 'accepted' },
          { ...stranger, responseStatus: 'accepted' },
        ],
      }),
      timed('no creator', { organizer: me, attendees: [{ ...me, organizer: true, responseStatus: 'accepted' }] }),
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => [item.id, item.own])).toEqual([
      ['spoofed', false],
      ['no creator', false],
    ]);
  });

  it('counts an event someone the person shares with made for them, with no one else on it', async () => {
    const assistant = { email: 'assistant@example.com' };
    const events = await sourceOf([
      timed('made for me', { organizer: me, creator: assistant }),
      timed('just me', {}),
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => [item.id, item.own])).toEqual([
      ['made for me', true],
      ['just me', true],
    ]);
  });

  it('takes an accept Google reports on an outside invite as the person’s own answer', async () => {
    // Calendar does not say whether an accept came from the person or from the invite file, so it is believed.
    const events = await sourceOf([
      timed('outside', {
        organizer: stranger,
        creator: stranger,
        attendees: [
          { ...me, responseStatus: 'accepted' },
          { ...stranger, organizer: true, responseStatus: 'accepted' },
        ],
      }),
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => [item.id, item.own])).toEqual([['outside', true]]);
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

  it('searches only the given senders, in groups, leaving out an address it cannot quote', async () => {
    const messages = [message({ id: '1', thread: 't-1', at: minute(51) })];
    const { api, listMessages } = gmail({ messages, perPage: 100 });
    const senders = Array.from({ length: 30 }, (_, n) => `person${String(n)}@example.com`);
    const read = await gmailMailSource(api).listNewMessages({
      since: minute(0),
      before: NOW,
      limit: 10,
      from: [...senders, 'odd"name@example.com'],
    });
    expect(read.read === 'all' ? read.messages.map(item => item.id) : read.read).toEqual(['1']);
    const queries = listMessages.mock.calls.map(([input]) => input.query);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('{from:"person0@example.com" from:"person1@example.com"');
    expect(queries[1]).toContain('from:"person29@example.com"}');
    expect(queries.join(' ')).not.toContain('odd');
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
      const read = await readMailWindow({
        source,
        since,
        now: minute(30),
        limit: 1,
        keep_from: [],
        logger: { warn: jest.fn() },
      });
      seen.push(...read.messages.map(item => item.id));
      if (read.resume_from === undefined) break;
      since = read.resume_from;
    }
    expect(seen).toEqual(['x1', 'y1', 'x2']);
  });

  it('marks a message Gmail can never give back as unreadable, and passes other failures on', async () => {
    const { api } = gmail({ messages: [], perPage: 100 });
    const failing = (error: Error) =>
      gmailMailSource({
        ...api,
        getMessage: () => Promise.reject(error),
        getThread: () => Promise.reject(error),
      });
    const mailRef = { id: 'm', thread_id: 't', received_at: minute(1) };
    const gone = failing(new GoogleApiError({ status: 404, message: 'Gmail has no such message.' }));
    const garbled = failing(
      new GoogleApiError({
        status: 502,
        message: 'Gmail returned a response Aman could not read.',
        cause: new z.ZodError([]),
      }),
    );
    const limited = failing(new GoogleApiError({ status: 429, message: 'Too many requests.' }));
    const asMail = {
      ...mailRef,
      from_address: 'dana@example.com',
      from_name: null,
      subject: '',
      snippet: '',
      authentication_results: [],
    };
    await expect(gone.readText(asMail)).rejects.toBeInstanceOf(MessageUnreadableError);
    await expect(gone.laterInThread(mailRef)).rejects.toBeInstanceOf(MessageUnreadableError);
    await expect(garbled.readText(asMail)).rejects.toBeInstanceOf(MessageUnreadableError);
    await expect(limited.readText(asMail)).rejects.toThrow('Too many requests.');
    await expect(limited.laterInThread(mailRef)).rejects.not.toBeInstanceOf(MessageUnreadableError);
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

describe('googleCalendarTimezoneFor', () => {
  const OWNER = { tenant_id: 'default', created_by: 'owner-1' };

  async function connections(scopes: string[]) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteGoogleConnectionStore(db);
    await store.save({
      ...OWNER,
      client_id: '123456-abcdefgh.apps.googleusercontent.com',
      client_secret: 'synthetic-secret',
      client_type: 'desktop',
      refresh_token: 'synthetic-refresh',
      granted_scopes: scopes,
      account_email: 'me@example.com',
      status: 'connected',
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
    });
    return store;
  }

  const fetchImpl = jest.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.startsWith(GOOGLE_TOKEN_URL)
      ? { access_token: 'synthetic-access', expires_in: 3600 }
      : { timeZone: 'Europe/Paris' };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });

  it('reads the time zone the person’s own calendar is kept in', async () => {
    const store = await connections(['https://www.googleapis.com/auth/calendar.events.readonly']);
    await expect(googleCalendarTimezoneFor({ connections: store, fetchImpl })(OWNER)).resolves.toBe('Europe/Paris');
  });

  it('says nothing for someone who did not allow calendar reads, or has no Google login', async () => {
    fetchImpl.mockClear();
    const store = await connections(['https://www.googleapis.com/auth/gmail.readonly']);
    const zoneFor = googleCalendarTimezoneFor({ connections: store, fetchImpl });
    await expect(zoneFor(OWNER)).resolves.toBeUndefined();
    await expect(zoneFor({ tenant_id: 'default', created_by: 'someone-else' })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
