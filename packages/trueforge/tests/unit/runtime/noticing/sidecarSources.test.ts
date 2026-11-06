import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import winston from 'winston';

import {
  bareSubject,
  createSidecarNoticingSources,
  sidecarCalendarSource,
  sidecarMailSource,
  SidecarToolError,
  toolResultOf,
  type CallSidecarTool,
} from '../../../../src/runtime/noticing/sidecarSources';
import {
  MailSourceBusyError,
  MailTooSlowError,
  MessageUnreadableError,
  type NoticingSourceProvider,
} from '../../../../src/runtime/noticing/sources';
import { readMailWindow, watchCalendar, watchMail } from '../../../../src/runtime/noticing/watchers';
import { defaultReachSettings } from '../../../../src/schemas/reach';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const OWNER = { tenant_id: 'default', created_by: 'owner-1' };

/** The connector reads each message on its own and lists the ones it could not fetch in `failed_ids`, never as an error. */
function mailTool(
  emails: unknown[],
  bodies: Record<string, string> = {},
  failed: readonly string[] = [],
): { call: CallSidecarTool; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  const call: CallSidecarTool = (name, args) => {
    calls.push([name, args]);
    if (name === 'get_emails_content') {
      const ids = Array.isArray(args['email_ids']) ? args['email_ids'] : [];
      const found = ids.filter(id => !failed.includes(String(id)));
      return Promise.resolve({
        structuredContent: {
          emails: found.map(id => ({ email_id: id, body: bodies[String(id)] ?? '' })),
          requested_count: ids.length,
          retrieved_count: found.length,
          failed_ids: ids.filter(id => failed.includes(String(id))),
        },
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

  it('reads a window in one call, and says when the window holds more than that call can list', async () => {
    const mail = Array.from({ length: 150 }, (_, n) => ({
      email: { ...EMAIL, email_id: String(n) },
      arrived: new Date(Date.UTC(2026, 10, 5, 12, 0, n)).toISOString(),
    }));
    const calls: Record<string, unknown>[] = [];
    const listing = inbox(mail);
    const source = sidecarMailSource({
      call: (name, args) => {
        calls.push(args);
        return listing(name, args);
      },
      account: 'default',
    });
    const some = await source.listNewMessages({
      since: new Date('2026-11-05T12:00:00Z'),
      before: new Date('2026-11-05T12:00:50Z'),
      limit: 100,
    });
    expect(some.read === 'all' ? some.messages.length : some.read).toBe(50);
    await expect(
      source.listNewMessages({ since: new Date('2026-11-05T12:00:00Z'), before: NOW, limit: 200 }),
    ).resolves.toEqual({ read: 'too_many' });
    await expect(
      source.listNewMessages({ since: new Date('2026-11-05T12:00:00Z'), before: NOW, limit: 20 }),
    ).resolves.toEqual({ read: 'too_many' });
    expect(calls.map(args => [args['page'], args['page_size']])).toEqual([
      [1, 100],
      [1, 100],
      [1, 21],
    ]);
  });

  it('moves a Date its sender wrote outside the window to the window’s edge', async () => {
    const early = { ...EMAIL, email_id: '8', date: '2026-11-05T10:00:00+00:00' };
    const late = { ...EMAIL, email_id: '9', date: '2026-11-09T10:00:00+00:00' };
    const garbled = { ...EMAIL, email_id: '10', date: 'yesterday-ish' };
    const call = inbox([
      { email: EMAIL, arrived: '2026-11-05T14:55:00Z' },
      { email: early, arrived: '2026-11-05T14:56:00Z' },
      { email: late, arrived: '2026-11-05T14:57:00Z' },
      { email: garbled, arrived: '2026-11-05T14:58:00Z' },
    ]);
    const since = new Date('2026-11-05T14:13:00.000Z');
    const read = await sidecarMailSource({ call, account: 'default' }).listNewMessages({
      since,
      before: NOW,
      limit: 50,
    });
    const latest = new Date(NOW.getTime() - 1);
    expect(read.read === 'all' ? read.messages.map(message => [message.id, message.received_at]) : read.read).toEqual([
      ['7', new Date('2026-11-05T14:55:00.000Z')],
      ['8', since],
      ['9', latest],
      ['10', latest],
    ]);
  });

  it('lists mail from given senders only, one call each', async () => {
    const { call, calls } = mailTool([EMAIL]);
    const read = await sidecarMailSource({ call, account: 'default' }).listNewMessages({
      since: new Date('2026-11-05T14:00:00.000Z'),
      before: NOW,
      limit: 50,
      from: ['dana@example.com', 'billing@power.test'],
    });
    expect(read.read === 'all' ? read.messages.length : read.read).toBe(2);
    expect(calls.map(([, args]) => args['from_address'])).toEqual(['dana@example.com', 'billing@power.test']);
  });

  it('fails the list on the first call that runs out of time, without trying a shorter window', async () => {
    const calls: unknown[] = [];
    const call: CallSidecarTool = (_name, args) => {
      calls.push(args);
      return Promise.reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
    };
    const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
      since: new Date('2026-11-05T14:00:00.000Z'),
      before: NOW,
      limit: 50,
    });
    await expect(read).rejects.toBeInstanceOf(MailTooSlowError);
    expect(calls).toHaveLength(1);
  });

  describe('when the connector cannot give a message', () => {
    const MAIL_REF = { id: '7', thread_id: 'Your invoice', received_at: new Date('2026-11-05T14:55:00.000Z') };
    const asMail = {
      ...MAIL_REF,
      from_address: 'billing@power.test',
      from_name: null,
      subject: '',
      snippet: '',
      authentication_results: [],
    };
    const failing =
      (reply: string): CallSidecarTool =>
      () =>
        Promise.reject(new SidecarToolError({ server: 'Email', tool: 'get_emails_content', reply }));

    it('reads an error result as an error, never as an empty list', () => {
      const result = { isError: true, content: [{ type: 'text', text: 'Account Home was not found' }] };
      expect(() => toolResultOf({ server: 'Email', tool: 'get_emails_content', result })).toThrow(SidecarToolError);
      const ok = { structuredContent: { emails: [] } };
      expect(toolResultOf({ server: 'Email', tool: 'list_emails_metadata', result: ok })).toBe(ok);
    });

    it('treats a message it lists in failed_ids as a failure that may clear, not as a message that is gone', async () => {
      const { call } = mailTool([], {}, ['7']);
      const failure = sidecarMailSource({ call, account: 'default' }).readText(asMail);
      await expect(failure).rejects.toThrow('could not fetch');
      await expect(failure).rejects.not.toBeInstanceOf(MessageUnreadableError);
      await expect(failure).rejects.not.toBeInstanceOf(MailSourceBusyError);
    });

    it('fails a later-reply read when any reply could not be fetched, so a paid bill is not raised', async () => {
      const reply = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
      const { call } = mailTool([reply], { '8': 'Paid, thanks' }, ['8']);
      await expect(sidecarMailSource({ call, account: 'default' }).laterInThread(MAIL_REF)).rejects.toThrow(
        'could not fetch',
      );
    });

    it('does not read "Account not found" as a message that is gone, so no bill is raised as unpaid', async () => {
      const source = sidecarMailSource({ call: failing('Account Home was not found'), account: 'default' });
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(SidecarToolError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(SidecarToolError);
    });

    it('marks a dropped connection or a call the client gave up on as a busy server', async () => {
      const dropped: CallSidecarTool = () => Promise.reject(new Error('connection refused'));
      const gaveUp: CallSidecarTool = () => Promise.reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
      for (const call of [dropped, gaveUp]) {
        const source = sidecarMailSource({ call, account: 'default' });
        await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
        await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
      }
    });

    it('says too slow when the connector gave up on a list by its own limit', async () => {
      const call = failing('Error calling tool: provider request timed out after 60 seconds');
      const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:00:00.000Z'),
        before: NOW,
        limit: 50,
      });
      await expect(read).rejects.toBeInstanceOf(MailTooSlowError);
    });
  });

  it('passes on other failures as a busy server', async () => {
    const call: CallSidecarTool = () => Promise.reject(new Error('connection refused'));
    const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
      since: new Date('2026-11-05T14:00:00.000Z'),
      before: NOW,
      limit: 50,
    });
    await expect(read).rejects.toBeInstanceOf(MailSourceBusyError);
    await expect(read).rejects.toHaveProperty('cause', expect.objectContaining({ message: 'connection refused' }));
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
      const read = await readMailWindow({
        source,
        since,
        now: NOW,
        limit: 100,
        keep_from: [],
        logger: { warn: jest.fn() },
      });
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
      stuck: undefined,
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
  const event = (
    { id, start, end }: { id: string; start: string; end: string },
    extra: Record<string, unknown> = {},
  ) => ({
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
            event({ id: 'a', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' }),
            event(
              { id: 'b', start: '2026-11-05T17:30:00+01:00', end: '2026-11-05T18:30:00+01:00' },
              { location: '12 Main Street' },
            ),
            event(
              { id: 'c', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              { status: 'CANCELLED' },
            ),
            event(
              { id: 'd', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              {
                attendees: [{ is_self: true, status: 'DECLINED' }],
              },
            ),
            { id: 'e', summary: 'All day', start: time('2026-11-05', true), end: time('2026-11-06', true) },
            event({ id: 'f', start: '2026-11-05T17:00:00', end: '2026-11-05T18:00:00' }),
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
            event({ id: 'alone', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' }),
            event(
              { id: 'forged-organizer', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              {
                organizer: { email: 'me@example.com', is_self: true },
                attendees: [{ email: 'guest@example.com', is_self: false, status: 'NEEDS-ACTION' }],
              },
            ),
            event(
              { id: 'forged-acceptance', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              {
                organizer: { email: 'stranger@example.com', is_self: false },
                attendees: [
                  { email: 'me@example.com', is_self: true, status: 'ACCEPTED' },
                  { email: 'me@example.com', is_self: true, status: 'NEEDS-ACTION' },
                ],
              },
            ),
            event(
              { id: 'organizer-only', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              {
                organizer: { email: 'me@example.com', is_self: true },
              },
            ),
            event(
              { id: 'invite', start: '2026-11-05T17:00:00+01:00', end: '2026-11-05T18:00:00+01:00' },
              {
                organizer: { email: 'stranger@example.com', is_self: false },
                attendees: [{ email: 'me@example.com', is_self: true, status: 'NEEDS-ACTION' }],
              },
            ),
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

  it('says a mail connector that is set up but cannot be reached is unreachable, not missing', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://127.0.0.1:1/mcp',
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    const sources = await provider.sourcesFor(OWNER);
    expect(sources.mail).toBeUndefined();
    expect(sources.mail_unreachable?.error).toBeInstanceOf(Error);
  });

  it('says nothing is unreachable when no mail connector is set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail_unreachable).toBeUndefined();
  });
});
