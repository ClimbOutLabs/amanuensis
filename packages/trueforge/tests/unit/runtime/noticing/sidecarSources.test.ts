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
  type NoticingSources,
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
  it('says its dates are the sender’s, not when the mail arrived', () => {
    expect(sidecarMailSource({ call: mailTool([]).call, account: 'default' }).datesAreArrival).toBe(false);
  });

  it('reads new inbox mail without marking it read, and never vouches for a sender', async () => {
    const { call, calls } = mailTool([EMAIL], { '7': 'Amount due by November 7' });
    const source = sidecarMailSource({ call, account: 'default' });
    const read = await source.listNewMessages({
      since: new Date('2026-11-05T14:00:00.000Z'),
      before: NOW,
      limit: 50,
      out_of_time: () => false,
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
      out_of_time: () => false,
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
      out_of_time: () => false,
    });
    expect(some.read === 'all' ? some.messages.length : some.read).toBe(50);
    await expect(
      source.listNewMessages({
        since: new Date('2026-11-05T12:00:00Z'),
        before: NOW,
        limit: 200,
        out_of_time: () => false,
      }),
    ).resolves.toEqual({ read: 'too_many' });
    await expect(
      source.listNewMessages({
        since: new Date('2026-11-05T12:00:00Z'),
        before: NOW,
        limit: 20,
        out_of_time: () => false,
      }),
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
      out_of_time: () => false,
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
      out_of_time: () => false,
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
      out_of_time: () => false,
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

    it('leaves out a later reply the connector could not fetch, so a stranger cannot hide a payment', async () => {
      const paid = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
      const stranger = { ...EMAIL, email_id: '9', subject: 'Re: Your invoice', date: '2026-11-05T14:59:00+00:00' };
      const { call } = mailTool([paid, stranger], { '8': 'Paid, thanks' }, ['9']);
      await expect(sidecarMailSource({ call, account: 'default' }).laterInThread(MAIL_REF)).resolves.toEqual([
        'Paid, thanks',
      ]);
    });

    it('tracks a bill, and does not stop the pass, when the connector refuses the thread check', async () => {
      const bill = {
        ...asMail,
        subject: 'Your invoice: amount due by November 7',
        received_at: new Date('2026-11-05T14:55:00.000Z'),
      };
      const call: CallSidecarTool = (name, args) => {
        if (name === 'get_emails_content' && Array.isArray(args['email_ids']) && args['email_ids'].length > 0) {
          return args['email_ids'].includes('7')
            ? Promise.resolve({
                structuredContent: { emails: [{ email_id: '7', body: 'Amount due by November 7' }], failed_ids: [] },
              })
            : Promise.reject(new SidecarToolError({ server: 'Email', tool: name, reply: 'limit_exceeded' }));
        }
        return Promise.resolve({
          structuredContent: {
            emails: [{ ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' }],
          },
        });
      };
      const source = sidecarMailSource({ call, account: 'default' });
      const found = await watchMail({
        source: { ...source, listNewMessages: () => Promise.resolve({ read: 'all', messages: [bill] }) },
        settings: defaultReachSettings('UTC'),
        since: new Date('2026-11-05T14:00:00.000Z'),
        now: NOW,
        logger: { warn: jest.fn() },
        stuck: undefined,
        out_of_time: () => false,
        assistant: 'Mira',
        max_width: undefined,
      });
      expect(found.track.map(event => event.id)).toEqual(['bill_due:7']);
      expect(found.stopped_by).toBeUndefined();
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

    it('marks a content or thread read the connector timed out on as a busy server', async () => {
      const source = sidecarMailSource({
        call: failing('Error calling tool: provider request timed out after 60 seconds'),
        account: 'default',
      });
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.readText(asMail)).rejects.not.toBeInstanceOf(MailTooSlowError);
    });

    it('marks the session ending mid-pass as a busy server', async () => {
      const ended: CallSidecarTool = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      const source = sidecarMailSource({ call: ended, account: 'default' });
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
    });

    it('marks a connector reply that names a lost connection, a missing connection or a failed login as a busy server', async () => {
      for (const reply of ['Error: TRANSPORT failure', 'IMAP client is not connected', 'IMAP login failed (NO)']) {
        const source = sidecarMailSource({ call: failing(reply), account: 'default' });
        await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
        await expect(
          source.listNewMessages({
            since: new Date('2026-11-05T14:00:00.000Z'),
            before: NOW,
            limit: 50,
            out_of_time: () => false,
          }),
        ).rejects.toBeInstanceOf(MailSourceBusyError);
      }
    });

    it('skips at once a message whose body is over the connector’s limit', async () => {
      const source = sidecarMailSource({
        call: failing('limit_exceeded: an email body exceeds the size limit'),
        account: 'default',
      });
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MessageUnreadableError);
    });

    it('says too slow when the connector gave up on a list by its own limit', async () => {
      const call = failing('Error calling tool: provider request timed out after 60 seconds');
      const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:00:00.000Z'),
        before: NOW,
        limit: 50,
        out_of_time: () => false,
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
      out_of_time: () => false,
    });
    await expect(read).rejects.toBeInstanceOf(MailSourceBusyError);
    await expect(read).rejects.toHaveProperty('cause', expect.objectContaining({ message: 'connection refused' }));
  });

  describe('a crafted header next to a real bill', () => {
    const BILL = { ...EMAIL, email_id: '7', subject: 'Invoice: amount due by November 7' };
    const BAD = { ...EMAIL, email_id: '8', subject: 'Crafted', sender: 'x <x@example.com>' };
    // The connector fetches headers only for the page it lists, and fails the whole page when one message does not parse.
    const connector = (): { call: CallSidecarTool; pageSizes: number[] } => {
      const pageSizes: number[] = [];
      const mail = [
        { email: BILL, arrived: '2026-11-05T14:55:00.000Z' },
        { email: BAD, arrived: '2026-11-05T14:55:01.000Z' },
      ];
      const listing = inbox(mail);
      const call: CallSidecarTool = (name, args) => {
        if (name === 'get_emails_content') {
          return Promise.resolve({
            structuredContent: { emails: [{ email_id: '7', body: 'Amount due by November 7' }], failed_ids: [] },
          });
        }
        pageSizes.push(Number(args['page_size']));
        const page = Number(args['page']);
        const size = Number(args['page_size']);
        const since = new Date(String(args['since'])).getTime();
        const before = new Date(String(args['before'])).getTime();
        const inWindow = mail.filter(item => {
          const arrived = new Date(item.arrived).getTime();
          return arrived >= since && arrived < before;
        });
        if (inWindow.slice((page - 1) * size, page * size).some(item => item.email.email_id === '8')) {
          return Promise.reject(
            new SidecarToolError({ server: 'Email', tool: name, reply: 'Error: incomplete metadata page' }),
          );
        }
        return listing(name, args);
      };
      return { call, pageSizes };
    };

    it('finds the one bad message by paging, and reads the bill beside it in the same pass', async () => {
      const { call, pageSizes } = connector();
      const warnings = { warn: jest.fn() };
      const found = await watchMail({
        source: sidecarMailSource({ call, account: 'default' }),
        settings: defaultReachSettings('UTC'),
        since: new Date('2026-11-05T14:00:00.000Z'),
        now: NOW,
        logger: warnings,
        stuck: undefined,
        out_of_time: () => false,
        assistant: 'Mira',
        max_width: undefined,
      });
      // The one message the connector cannot list is told about in a fixed note.
      expect(found.raise.map(event => event.id)).toEqual([
        'mail_gap:2026-11-05T14:55:00.000Z:2026-11-05T14:55:04.000Z',
        'bill_due:7',
      ]);
      expect(found.resume_from).toBeUndefined();
      expect(found.stopped_by).toBeUndefined();
      expect(pageSizes).toContain(1);
      expect(warnings.warn).toHaveBeenCalledWith(
        'Left out mail the mail server could not list one by one',
        expect.objectContaining({ skipped: 1 }),
      );
    });

    it('reads the bill beside three crafted headers in the same few seconds, and tells of the three', async () => {
      const bad = (id: string, second: number) => ({
        email: { ...EMAIL, email_id: id, subject: 'Crafted' },
        arrived: `2026-11-05T14:55:0${String(second)}.000Z`,
      });
      const mail = [
        bad('8', 0),
        bad('9', 1),
        bad('10', 2),
        {
          email: { ...EMAIL, email_id: '7', subject: 'Invoice: amount due by November 7' },
          arrived: '2026-11-05T14:55:03.000Z',
        },
      ];
      const listing = inbox(mail);
      const call: CallSidecarTool = (name, args) => {
        if (name === 'get_emails_content') {
          return Promise.resolve({
            structuredContent: { emails: [{ email_id: '7', body: 'Amount due by November 7' }], failed_ids: [] },
          });
        }
        const page = Number(args['page']);
        const size = Number(args['page_size']);
        const since = new Date(String(args['since'])).getTime();
        const before = new Date(String(args['before'])).getTime();
        const ahead = mail
          .filter(item => {
            const arrived = new Date(item.arrived).getTime();
            return arrived >= since && arrived < before;
          })
          .slice((page - 1) * size, page * size);
        return ahead.some(item => item.email.subject === 'Crafted')
          ? Promise.reject(new SidecarToolError({ server: 'Email', tool: name, reply: 'incomplete metadata page' }))
          : listing(name, args);
      };
      const found = await watchMail({
        source: sidecarMailSource({ call, account: 'default' }),
        settings: defaultReachSettings('UTC'),
        since: new Date('2026-11-05T14:00:00.000Z'),
        now: NOW,
        logger: { warn: jest.fn() },
        stuck: undefined,
        out_of_time: () => false,
        assistant: 'Mira',
        max_width: undefined,
      });
      expect(found.raise.map(event => event.id)).toEqual([
        'mail_gap:2026-11-05T14:55:00.000Z:2026-11-05T14:55:04.000Z',
        'bill_due:7',
      ]);
      expect(found.stopped_by).toBeUndefined();
      expect(found.resume_from).toBeUndefined();
    });

    it('tries a failing page once more before it leaves the message out', async () => {
      let tries = 0;
      const listing = inbox([{ email: BILL, arrived: '2026-11-05T14:55:00.000Z' }]);
      const call: CallSidecarTool = (name, args) => {
        if (Number(args['page_size']) === 1) {
          tries += 1;
          if (tries === 1) {
            return Promise.reject(new SidecarToolError({ server: 'Email', tool: name, reply: 'incomplete page' }));
          }
        } else {
          return Promise.reject(new SidecarToolError({ server: 'Email', tool: name, reply: 'incomplete page' }));
        }
        return listing(name, args);
      };
      const read = await sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:55:00.000Z'),
        before: new Date('2026-11-05T14:55:02.000Z'),
        limit: 50,
        out_of_time: () => false,
      });
      expect(read).toMatchObject({ read: 'all', messages: [{ id: '7' }] });
      expect(read).not.toHaveProperty('skipped');
    });

    it('stops searching one message at a time when the pass has run out of time', async () => {
      const calls: number[] = [];
      const call: CallSidecarTool = (_name, args) => {
        calls.push(Number(args['page']));
        return Promise.reject(new SidecarToolError({ server: 'Email', tool: 'x', reply: 'incomplete page' }));
      };
      let looks = 0;
      const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:55:00.000Z'),
        before: new Date('2026-11-05T14:55:02.000Z'),
        limit: 500,
        out_of_time: () => (looks += 1) > 2,
      });
      await expect(read).rejects.toBeInstanceOf(MailTooSlowError);
      expect(calls.length).toBeLessThan(8);
    });

    it('does not search one message at a time when the list is only a check on the account', async () => {
      const call = jest.fn<ReturnType<CallSidecarTool>, Parameters<CallSidecarTool>>(() =>
        Promise.reject(new SidecarToolError({ server: 'Email', tool: 'x', reply: 'incomplete page' })),
      );
      const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:55:00.000Z'),
        before: new Date('2026-11-05T14:55:02.000Z'),
        limit: 500,
        out_of_time: () => false,
        whole: true,
      });
      await expect(read).rejects.toBeInstanceOf(SidecarToolError);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('reads a few seconds that hold more than one page of mail whole', async () => {
      const mail = Array.from({ length: 250 }, (_, n) => ({
        email: { ...EMAIL, email_id: String(n) },
        arrived: new Date(Date.UTC(2026, 10, 5, 14, 55, 0, n * 10)).toISOString(),
      }));
      const read = await sidecarMailSource({ call: inbox(mail), account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:55:00.000Z'),
        before: new Date('2026-11-05T14:55:04.000Z'),
        limit: 500,
        out_of_time: () => false,
      });
      expect(read.read === 'all' ? read.messages : []).toHaveLength(250);
    });

    it('leaves a list that fails for every page to the caller, since that is the account and not a message', async () => {
      const call: CallSidecarTool = () =>
        Promise.reject(
          new SidecarToolError({ server: 'Email', tool: 'list_emails_metadata', reply: 'Account X was not found' }),
        );
      const read = sidecarMailSource({ call, account: 'default' }).listNewMessages({
        since: new Date('2026-11-05T14:55:00.000Z'),
        before: new Date('2026-11-05T14:55:02.000Z'),
        limit: 50,
        out_of_time: () => false,
      });
      await expect(read).rejects.toBeInstanceOf(SidecarToolError);
    });
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
        out_of_time: () => false,
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
      out_of_time: () => false,
      assistant: 'Mira',
      max_width: undefined,
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
    sourcesFor: () => Promise.resolve({ mail: { status: 'none' }, calendar: undefined }),
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
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({ mail: { status: 'none' }, calendar: undefined });
  });

  it('keeps a person’s own Google sources over the sidecar', async () => {
    const own: NoticingSources = {
      mail: {
        status: 'ready',
        source: sidecarMailSource({ call: mailTool([]).call, account: 'a' }),
        kind: 'google',
      },
      calendar: undefined,
    };
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
    await expect(provider.sourcesFor(second)).resolves.toEqual({ mail: { status: 'none' }, calendar: undefined });
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
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({ mail: { status: 'none' }, calendar: undefined });
    await expect(provider.listOwners()).resolves.toEqual([OWNER]);
  });

  it('uses the shared connector only when Google gives no mail, never in place of a Google login that must be redone', async () => {
    const reconnect: NoticingSources = {
      mail: { status: 'unreachable', error: new Error('Google needs to be connected again.'), kind: 'google' },
      calendar: undefined,
    };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      calendarUrl: undefined,
      primary: { ...none, sourcesFor: () => Promise.resolve(reconnect) },
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail).toBe(reconnect.mail);
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
    expect(sources.mail.status).toBe('unreachable');
    expect(sources.mail.status === 'unreachable' ? sources.mail.error : undefined).toBeInstanceOf(Error);
  });

  it('says nothing is unreachable when no mail connector is set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail).toEqual({ status: 'none' });
  });
});
