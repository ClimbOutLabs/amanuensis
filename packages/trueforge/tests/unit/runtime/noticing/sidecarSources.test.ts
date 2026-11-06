import winston from 'winston';

import {
  bareSubject,
  createSidecarNoticingSources,
  sidecarCalendarSource,
  sidecarMailSource,
  type CallSidecarTool,
} from '../../../../src/runtime/noticing/sidecarSources';
import type { NoticingSourceProvider } from '../../../../src/runtime/noticing/sources';
import { readMailWindow, watchCalendar, watchMail } from '../../../../src/runtime/noticing/watchers';
import { defaultReachSettings } from '../../../../src/schemas/reach';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const OWNER = { tenant_id: 'default', created_by: 'owner-1' };

function mailTool(
  emails: unknown[],
  bodies: Record<string, string> = {},
): { call: CallSidecarTool; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  const call: CallSidecarTool = (name, args) => {
    calls.push([name, args]);
    if (name === 'get_emails_content') {
      const ids = Array.isArray(args['email_ids']) ? args['email_ids'] : [];
      return Promise.resolve({
        structuredContent: { emails: ids.map(id => ({ email_id: id, body: bodies[String(id)] ?? '' })) },
      });
    }
    return Promise.resolve({ structuredContent: { emails } });
  };
  return { call, calls };
}

const EMAIL = {
  email_id: '7',
  subject: 'Your invoice',
  sender: 'Power Co <billing@power.test>',
  recipients: ['me@example.com'],
  date: '2026-11-05T14:55:00+00:00',
  attachments: [],
};

describe('sidecar mail source (IMAP)', () => {
  it('reads new inbox mail without marking it read, and never vouches for a sender', async () => {
    const { call, calls } = mailTool([EMAIL], { '7': 'Amount due by November 7' });
    const source = sidecarMailSource({ call, account: 'default' });
    const read = await source.listNewMessages({
      since: new Date('2026-11-05T14:00:00.000Z'),
      before: NOW,
      limit: 50,
    });
    const messages = read.read === 'all' ? read.messages : [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: '7',
      from_address: 'billing@power.test',
      from_name: 'Power Co',
      authentication_results: [],
    });
    expect(await source.readText(messages[0] ?? EMAIL_MESSAGE)).toBe('Amount due by November 7');
    expect(calls.at(-1)?.[1]).toMatchObject({ mark_as_read: false });
    expect(source.trustedAuthenticationServers).toEqual([]);
  });

  /** The sidecar picks mail by the server's arrival time, which a sender cannot set, and lists it oldest first. */
  function inbox(mail: { email: typeof EMAIL; arrived: string }[]): CallSidecarTool {
    return (_name, args) => {
      const since = new Date(String(args['since'])).getTime();
      const before = new Date(String(args['before'])).getTime();
      const page = Number(args['page']);
      const size = Number(args['page_size']);
      const emails = mail
        .filter(item => new Date(item.arrived).getTime() >= since && new Date(item.arrived).getTime() < before)
        .sort((a, b) => new Date(a.arrived).getTime() - new Date(b.arrived).getTime())
        .map(item => item.email)
        .slice((page - 1) * size, page * size);
      return Promise.resolve({ structuredContent: { emails } });
    };
  }

  it('keeps mail the server got late, whatever Date its sender wrote, in the order the server got it', async () => {
    const delayed = { ...EMAIL, email_id: '8', date: '2026-11-05T10:00:00+00:00' };
    const garbled = { ...EMAIL, email_id: '9', date: 'yesterday-ish' };
    const call = inbox([
      { email: EMAIL, arrived: '2026-11-05T14:55:00Z' },
      { email: delayed, arrived: '2026-11-05T14:56:00Z' },
      { email: garbled, arrived: '2026-11-05T14:57:00Z' },
    ]);
    const read = await sidecarMailSource({ call, account: 'default' }).listNewMessages({
      since: new Date('2026-11-05T14:13:00.000Z'),
      before: NOW,
      limit: 50,
    });
    expect(read.read === 'all' ? read.messages.map(message => message.id) : read.read).toEqual(['7', '8', '9']);
  });

  it('pages through the window and says when it holds more than one read takes', async () => {
    const mail = Array.from({ length: 150 }, (_, n) => ({
      email: { ...EMAIL, email_id: String(n) },
      arrived: new Date(Date.UTC(2026, 10, 5, 12, 0, n)).toISOString(),
    }));
    const source = sidecarMailSource({ call: inbox(mail), account: 'default' });
    const all = await source.listNewMessages({ since: new Date('2026-11-05T12:00:00Z'), before: NOW, limit: 200 });
    expect(all.read === 'all' ? all.messages.length : all.read).toBe(150);
    await expect(
      source.listNewMessages({ since: new Date('2026-11-05T12:00:00Z'), before: NOW, limit: 120 }),
    ).resolves.toEqual({ read: 'too_many' });
  });

  it('reads a backlog bigger than one pass over several passes, skipping nothing', async () => {
    const mail = Array.from({ length: 250 }, (_, n) => ({
      email: { ...EMAIL, email_id: String(n) },
      arrived: new Date(Date.UTC(2026, 10, 5, 12, 0, 0, n * 997)).toISOString(),
    }));
    const source = sidecarMailSource({ call: inbox(mail), account: 'default' });
    const seen = new Set<string>();
    let since = new Date('2026-11-05T12:00:00Z');
    for (let pass = 0; pass < 20; pass += 1) {
      const read = await readMailWindow({ source, since, now: NOW, limit: 100, logger: { warn: jest.fn() } });
      read.messages.forEach(message => seen.add(message.id));
      if (read.resume_from === undefined) break;
      expect(read.resume_from.getTime()).toBeGreaterThan(since.getTime());
      since = read.resume_from;
    }
    expect(seen.size).toBe(250);
  });

  it('treats an always-important sender as ordinary mail, so only a bill note can come of it', async () => {
    const { call } = mailTool([EMAIL], { '7': 'Amount due by November 7' });
    const settings = {
      ...defaultReachSettings('UTC'),
      always_important: [
        { address: 'billing@power.test', source: 'settings' as const, added_at: '2026-11-01T00:00:00.000Z' },
      ],
    };
    const found = await watchMail({
      source: sidecarMailSource({ call, account: 'default' }),
      settings,
      since: new Date('2026-11-05T14:00:00.000Z'),
      now: NOW,
      logger: { warn: jest.fn() },
    });
    expect(found.raise.map(event => [event.kind, event.evidence])).toEqual([['bill_due', 'content']]);
  });

  it('finds a later reply by the bare subject', async () => {
    const reply = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
    const { call, calls } = mailTool([reply], { '8': 'Thank you for your payment' });
    const later = await sidecarMailSource({ call, account: 'default' }).laterInThread({
      id: '7',
      thread_id: bareSubject('Re: Your invoice'),
      received_at: new Date('2026-11-05T14:55:00.000Z'),
    });
    expect(later).toEqual(['Thank you for your payment']);
    expect(calls[0]?.[1]).toMatchObject({ subject: 'Your invoice' });
  });

  it('strips reply prefixes', () => {
    expect(bareSubject('RE: Fwd: Hello')).toBe('Hello');
  });
});

const EMAIL_MESSAGE = {
  id: '7',
  thread_id: null,
  from_address: 'billing@power.test',
  from_name: null,
  subject: 'Your invoice',
  snippet: '',
  received_at: NOW,
  authentication_results: [],
};

describe('sidecar calendar source (CalDAV)', () => {
  const time = (value: string, all_day = false) => ({ value, tzid: 'Europe/Berlin', all_day });
  const event = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
    id,
    summary: id,
    start: time(start),
    end: time(end),
    ...extra,
  });

  it('keeps timed events that are on, and raises a clash and travel from them', async () => {
    const call: CallSidecarTool = () =>
      Promise.resolve({
        structuredContent: {
          events: [
            event('a', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00'),
            event('b', '2026-11-05T17:30:00+01:00', '2026-11-05T18:30:00+01:00', { location: '12 Main Street' }),
            event('c', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', { status: 'CANCELLED' }),
            event('d', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', {
              attendees: [{ is_self: true, status: 'DECLINED' }],
            }),
            { id: 'e', summary: 'All day', start: time('2026-11-05', true), end: time('2026-11-06', true) },
            event('f', '2026-11-05T17:00:00', '2026-11-05T18:00:00'),
          ],
        },
      });
    const source = sidecarCalendarSource({ call });
    const events = await source.listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => item.id)).toEqual(['a', 'b']);
    const found = await watchCalendar({ source, settings: defaultReachSettings('UTC'), now: NOW });
    expect(found.map(item => item.kind)).toContain('calendar_clash');
  });

  it('counts an event as the person’s own only when no one else is on it, since the invite writes who organised and who accepted', async () => {
    const call: CallSidecarTool = () =>
      Promise.resolve({
        structuredContent: {
          events: [
            event('alone', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00'),
            event('forged-organizer', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', {
              organizer: { email: 'me@example.com', is_self: true },
              attendees: [{ email: 'guest@example.com', is_self: false, status: 'NEEDS-ACTION' }],
            }),
            event('forged-acceptance', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', {
              organizer: { email: 'stranger@example.com', is_self: false },
              attendees: [
                { email: 'me@example.com', is_self: true, status: 'ACCEPTED' },
                { email: 'me@example.com', is_self: true, status: 'NEEDS-ACTION' },
              ],
            }),
            event('organizer-only', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', {
              organizer: { email: 'me@example.com', is_self: true },
            }),
            event('invite', '2026-11-05T17:00:00+01:00', '2026-11-05T18:00:00+01:00', {
              organizer: { email: 'stranger@example.com', is_self: false },
              attendees: [{ email: 'me@example.com', is_self: true, status: 'NEEDS-ACTION' }],
            }),
          ],
        },
      });
    const events = await sidecarCalendarSource({ call }).listEvents({
      from: NOW,
      to: new Date('2026-11-06T15:00:00.000Z'),
    });
    expect(events.map(item => [item.id, item.own])).toEqual([
      ['alone', true],
      ['forged-organizer', false],
      ['forged-acceptance', false],
      ['organizer-only', false],
      ['invite', false],
    ]);
  });

  it('sends the window to the sidecar', async () => {
    const call = jest.fn<ReturnType<CallSidecarTool>, Parameters<CallSidecarTool>>(() =>
      Promise.resolve({ structuredContent: { events: [] } }),
    );
    await sidecarCalendarSource({ call }).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(call).toHaveBeenCalledWith('list_events', expect.objectContaining({ from: NOW.toISOString() }));
  });
});

describe('createSidecarNoticingSources', () => {
  const none: NoticingSourceProvider = {
    listOwners: () => Promise.resolve([OWNER]),
    sourcesFor: () => Promise.resolve({ mail: undefined, calendar: undefined }),
  };

  it('offers nothing when no sidecar is set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    await expect(provider.listOwners()).resolves.toEqual([OWNER]);
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({ mail: undefined, calendar: undefined });
  });

  it('keeps a person’s own Google sources over the sidecar', async () => {
    const own = { mail: sidecarMailSource({ call: mailTool([]).call, account: 'a' }), calendar: undefined };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      calendarUrl: undefined,
      primary: { ...none, sourcesFor: () => Promise.resolve(own) },
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail).toBe(own.mail);
  });

  it('gives the shared connectors to the instance owner only', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      calendarUrl: 'http://calendar.invalid/mcp',
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    const second = { tenant_id: 'default', created_by: 'owner-2' };
    expect((await provider.sourcesFor(OWNER)).calendar).toBeDefined();
    await expect(provider.sourcesFor(second)).resolves.toEqual({ mail: undefined, calendar: undefined });
  });

  it('lists the instance owner so the shared connectors are watched, and no one else', async () => {
    const second = { tenant_id: 'default', created_by: 'owner-2' };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      calendarUrl: undefined,
      primary: { ...none, listOwners: () => Promise.resolve([second]) },
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    await expect(provider.listOwners()).resolves.toEqual([second, OWNER]);
  });

  it('gives the shared connectors to no one when the instance names no owner', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      calendarUrl: 'http://calendar.invalid/mcp',
      primary: none,
      instanceOwner: undefined,
      logger: winston.createLogger({ silent: true }),
    });
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({ mail: undefined, calendar: undefined });
    await expect(provider.listOwners()).resolves.toEqual([OWNER]);
  });
});
