import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import winston from 'winston';

import type { MailCursor } from '../../../../src/db/noticingStore';
import {
  bareSubject,
  createSidecarNoticingSources,
  imapAgent,
  imapMessageId,
  sidecarCalendarSource,
  sidecarMailSource,
  SidecarToolError,
  toolResultOf,
  type CallSidecarTool,
  type ListAfterAgent,
  type MailboxValidity,
} from '../../../../src/runtime/noticing/sidecarSources';
import {
  MailLoginFailedError,
  MailSourceBusyError,
  MailTooSlowError,
  MessageUnreadableError,
  type CursorRead,
  type NoticingSourceProvider,
  type NoticingSources,
} from '../../../../src/runtime/noticing/sources';
import { watchCalendar, watchMail } from '../../../../src/runtime/noticing/watchers';
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

/** Synthetic; the agent asks every caller for it. */
const AGENT_SECRET = 'test-agent-secret-0123456789abcdef0123';

const noAgent: ListAfterAgent = () => Promise.reject(new Error('This source does not list mail.'));

const mailSource = (
  call: CallSidecarTool,
  agent: ListAfterAgent = noAgent,
  validity: MailboxValidity = () => Promise.resolve(1),
) => sidecarMailSource({ call, account: 'default', agent, validity });

interface Arrival {
  uid: number;
  at: string;
  subject: string;
  bad: boolean;
}

function arrival({
  uid,
  at,
  subject = 'Invoice',
  bad = false,
}: {
  uid: number;
  at: string;
  subject?: string;
  bad?: boolean;
}): Arrival {
  return { uid, at, subject, bad };
}

/** A mailbox as the account agent lists it: by number after a cursor, a header that does not parse counted as skipped. */
function mailboxAgent(
  mail: Arrival[],
  uidvalidity = 1,
): { agent: ListAfterAgent; asked: Parameters<ListAfterAgent>[0][] } {
  const asked: Parameters<ListAfterAgent>[0][] = [];
  const agent: ListAfterAgent = request => {
    asked.push(request);
    const after = request.uidvalidity === uidvalidity ? request.last_uid : null;
    const since = Date.parse(request.since);
    const wanted = mail
      .filter(item => (after === null ? Date.parse(item.at) >= since : item.uid > after))
      .sort((a, b) => a.uid - b.uid);
    const taken = wanted.slice(0, request.limit);
    const last = taken.at(-1)?.uid ?? after ?? Math.max(0, ...mail.map(item => item.uid));
    return Promise.resolve({
      messages: taken
        .filter(item => !item.bad)
        .map(item => ({
          id: imapMessageId({ uidvalidity, uid: item.uid }),
          uid: item.uid,
          thread_id: bareSubject(item.subject),
          from_address: 'billing@power.test',
          from_name: 'Power Co',
          subject: item.subject,
          snippet: '',
          received_at: new Date(item.at),
          authentication_results: [],
        })),
      skipped: taken.filter(item => item.bad).length,
      cursor: { uidvalidity, last_uid: last },
      more: wanted.length > taken.length,
    });
  };
  return { agent, asked };
}

/** The connector for bodies and thread checks: every body is bill-like, and no later reply exists. */
function billsTool(): CallSidecarTool {
  return (name, args) => {
    if (name === 'get_emails_content') {
      const ids = Array.isArray(args['email_ids']) ? args['email_ids'] : [];
      return Promise.resolve({
        structuredContent: {
          emails: ids.map(id => ({ email_id: id, body: '' })),
          requested_count: ids.length,
          retrieved_count: ids.length,
          failed_ids: [],
        },
      });
    }
    return Promise.resolve({ structuredContent: { emails: [] } });
  };
}

describe('sidecar mail source (IMAP)', () => {
  const SINCE = new Date('2026-11-05T14:00:00.000Z');

  it('asks the account agent for the mail after the cursor, and never vouches for a sender', async () => {
    const { call, calls } = mailTool([], { '7': 'Amount due by November 7' });
    const { agent, asked } = mailboxAgent([arrival({ uid: 7, at: '2026-11-05T14:55:00.000Z' })]);
    const source = mailSource(call, agent);
    const read = await source.listAfter({
      cursor: { uidvalidity: 1, last_uid: 6 },
      since: SINCE,
      limit: 50,
      out_of_time: () => false,
    });
    expect(asked).toEqual([
      { uidvalidity: 1, last_uid: 6, dated_to_uid: null, dated_since: null, since: SINCE.toISOString(), limit: 50 },
    ]);
    expect(read.cursor).toEqual({ uidvalidity: 1, last_uid: 7 });
    expect(read.messages[0]).toMatchObject({
      id: 'imap:1:7',
      uid: 7,
      thread_id: 'Invoice',
      from_address: 'billing@power.test',
      from_name: 'Power Co',
      authentication_results: [],
      received_at: new Date('2026-11-05T14:55:00.000Z'),
    });
    expect(await source.readText(read.messages[0] ?? EMAIL_MESSAGE)).toBe('Amount due by November 7');
    // The connector's tools take the UID alone.
    expect(calls.at(-1)?.[1]).toMatchObject({ email_ids: ['7'], mark_as_read: false });
    expect(source.trustedAuthenticationServers).toEqual([]);
    expect(source.reportsSenderConfirmation).toBe(false);
  });

  it('sends no cursor on the first look, and the start time to list from', async () => {
    const { agent, asked } = mailboxAgent([]);
    await mailSource(mailTool([]).call, agent).listAfter({
      cursor: undefined,
      since: SINCE,
      limit: 10,
      out_of_time: () => false,
    });
    expect(asked).toEqual([
      {
        uidvalidity: null,
        last_uid: null,
        dated_to_uid: null,
        dated_since: null,
        since: SINCE.toISOString(),
        limit: 10,
      },
    ]);
  });

  it('sends back the part of the mailbox still to be dated', async () => {
    const { agent, asked } = mailboxAgent([]);
    await mailSource(mailTool([]).call, agent).listAfter({
      cursor: { uidvalidity: 1, last_uid: 200, dated: { to_uid: 912, since: SINCE } },
      since: new Date('2026-11-05T14:40:00.000Z'),
      limit: 10,
      out_of_time: () => false,
    });
    expect(asked[0]).toMatchObject({ last_uid: 200, dated_to_uid: 912, dated_since: SINCE.toISOString() });
  });

  it('fails the list without asking when the pass is already out of time', async () => {
    const { agent, asked } = mailboxAgent([]);
    const read = mailSource(mailTool([]).call, agent).listAfter({
      cursor: undefined,
      since: SINCE,
      limit: 10,
      out_of_time: () => true,
    });
    await expect(read).rejects.toBeInstanceOf(MailTooSlowError);
    expect(asked).toEqual([]);
  });

  describe('when the connector cannot give a message', () => {
    const MAIL_REF = { id: 'imap:1:7', thread_id: 'Your invoice', received_at: new Date('2026-11-05T14:55:00.000Z') };
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
      const failure = mailSource(call).readText(asMail);
      await expect(failure).rejects.toThrow('could not fetch');
      await expect(failure).rejects.not.toBeInstanceOf(MessageUnreadableError);
      await expect(failure).rejects.not.toBeInstanceOf(MailSourceBusyError);
    });

    it('leaves out a later reply the connector could not fetch, so a stranger cannot hide a payment', async () => {
      const paid = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
      const stranger = { ...EMAIL, email_id: '9', subject: 'Re: Your invoice', date: '2026-11-05T14:59:00+00:00' };
      const { call } = mailTool([paid, stranger], { '8': 'Paid, thanks' }, ['9']);
      await expect(mailSource(call).laterInThread(MAIL_REF)).resolves.toEqual(['Paid, thanks']);
    });

    it('does not count the bill itself as a later reply in its thread', async () => {
      const reply = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
      const { call } = mailTool([EMAIL, reply], { '7': 'Paid in advance by direct debit', '8': 'Thanks' });
      await expect(mailSource(call).laterInThread(MAIL_REF)).resolves.toEqual(['Thanks']);
    });

    it('never checks a bill from before the mailbox was renumbered against the mail now there', async () => {
      // After renumbering, UID 8 is the bill itself and UID 7 a payment notice from another thread.
      const sameBill = { ...EMAIL, email_id: '8', date: '2026-11-05T14:55:00+00:00' };
      const { call, calls } = mailTool([sameBill], { '8': 'Amount due by November 7', '7': 'Paid, thanks' });
      const asked: string[] = [];
      const source = mailSource(call, noAgent, () => {
        asked.push('validity');
        return Promise.resolve(2);
      });
      const failure = source.laterInThread(MAIL_REF);
      await expect(failure).rejects.toBeInstanceOf(MessageUnreadableError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MessageUnreadableError);
      expect(calls).toEqual([]);
      expect(asked).toEqual(['validity']);
    });

    it('checks the thread of a bill from the current numbering', async () => {
      const paid = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
      const { call } = mailTool([paid], { '8': 'Paid, thanks' });
      await expect(mailSource(call, noAgent, () => Promise.resolve(1)).laterInThread(MAIL_REF)).resolves.toEqual([
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
      const source = mailSource(call);
      const found = await watchMail({
        source: {
          ...source,
          listAfter: () =>
            Promise.resolve({
              messages: [{ ...bill, id: 'imap:1:7', uid: 7 }],
              skipped: 0,
              cursor: { uidvalidity: 1, last_uid: 7 },
              more: false,
            }),
        },
        settings: defaultReachSettings('UTC'),
        since: new Date('2026-11-05T14:00:00.000Z'),
        now: NOW,
        logger: { warn: jest.fn() },
        stuck: undefined,
        out_of_time: () => false,
        assistant: 'Mira',
      });
      expect(found.track.map(event => event.id)).toEqual(['bill_due:imap:1:7']);
      expect(found.stopped_by).toBeUndefined();
    });

    it('does not read "Account not found" as a message that is gone, so no bill is raised as unpaid', async () => {
      const source = mailSource(failing('Account Home was not found'));
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(SidecarToolError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(SidecarToolError);
    });

    it('marks a dropped connection or a call the client gave up on as a busy server', async () => {
      const dropped: CallSidecarTool = () => Promise.reject(new Error('connection refused'));
      const gaveUp: CallSidecarTool = () => Promise.reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
      for (const call of [dropped, gaveUp]) {
        const source = mailSource(call);
        await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
        await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
      }
    });

    it('marks a content or thread read the connector timed out on as a busy server', async () => {
      const source = mailSource(failing('Error calling tool: provider request timed out after 60 seconds'));
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.readText(asMail)).rejects.not.toBeInstanceOf(MailTooSlowError);
    });

    it('marks the session ending mid-pass as a busy server', async () => {
      const ended: CallSidecarTool = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      const source = mailSource(ended);
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(source.laterInThread(MAIL_REF)).rejects.toBeInstanceOf(MailSourceBusyError);
    });

    it('marks a connector reply that names a lost connection, a missing connection or a failed login as a busy server', async () => {
      for (const reply of ['Error: TRANSPORT failure', 'IMAP client is not connected', 'IMAP login failed (NO)']) {
        const source = mailSource(failing(reply));
        await expect(source.readText(asMail)).rejects.toBeInstanceOf(MailSourceBusyError);
      }
    });

    it('skips at once a message whose body is over the connector’s limit', async () => {
      const source = mailSource(failing('limit_exceeded: an email body exceeds the size limit'));
      await expect(source.readText(asMail)).rejects.toBeInstanceOf(MessageUnreadableError);
    });
  });

  describe('the account agent', () => {
    const reply = (status: number, body: unknown): typeof fetch =>
      jest.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        ),
      );
    const ask = (fetchImpl: typeof fetch) =>
      imapAgent({ url: 'http://agent.invalid', secret: AGENT_SECRET, fetchImpl })({
        uidvalidity: null,
        last_uid: null,
        dated_to_uid: null,
        dated_since: null,
        since: SINCE.toISOString(),
        limit: 10,
      });

    it('posts the request to the list route and reads the reply', async () => {
      const fetchImpl = reply(200, {
        uidvalidity: 3,
        last_uid: 9,
        dated_to_uid: null,
        dated_since: null,
        more: true,
        skipped: 0,
        messages: [
          {
            uid: 9,
            internal_date: '2026-11-05T14:55:00+00:00',
            from_address: 'A@B.test',
            from_name: null,
            subject: 'Re: Hi',
          },
        ],
      });
      const read = await ask(fetchImpl);
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://agent.invalid/list_after',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: `Bearer ${AGENT_SECRET}` }),
        }),
      );
      expect(read.cursor).toEqual({ uidvalidity: 3, last_uid: 9 });
      expect(read.more).toBe(true);
      expect(read.messages).toMatchObject([
        { id: 'imap:3:9', uid: 9, thread_id: 'Hi', from_address: 'a@b.test', from_name: null },
      ]);
    });

    it('names a message by its Message-ID, sender, date and subject, which stay the same when it is renumbered', async () => {
      const header = {
        internal_date: '2026-11-05T14:55:00+00:00',
        from_address: 'a@b.test',
        from_name: null,
        subject: 'Invoice',
        message_id: '<bill-1@power.test>',
        date: 'Thu, 5 Nov 2026 14:55:00 +0000',
      };
      const keysOf = async (uidvalidity: number, messages: Record<string, unknown>[]) =>
        (
          await ask(
            reply(200, {
              uidvalidity,
              last_uid: messages.length,
              dated_to_uid: null,
              dated_since: null,
              more: false,
              skipped: 0,
              messages: messages.map((message, index) => ({ ...header, uid: index + 1, ...message })),
            }),
          )
        ).messages.map(message => message.key);
      const [first, renumbered] = await Promise.all([keysOf(3, [{}]), keysOf(4, [{}])]);
      expect(first[0]).toMatch(/^mid:[0-9a-f]{32}$/);
      expect(renumbered[0]).toBe(first[0]);
      // The same Message-ID from another sender, on another date or with another subject is another message.
      const others = await keysOf(3, [
        { from_address: 'spoof@evil.test' },
        { date: 'Sat, 5 Dec 2026 14:55:00 +0000' },
        { subject: 'Invoice for December' },
        { message_id: null },
      ]);
      expect(new Set([first[0], ...others.slice(0, 3)]).size).toBe(4);
      expect(others[3]).toBeUndefined();
    });

    it('carries the part of the mailbox still to be dated in the cursor', async () => {
      const read = await ask(
        reply(200, {
          uidvalidity: 3,
          last_uid: 200,
          dated_to_uid: 912,
          dated_since: '2026-11-05T14:00:00Z',
          more: true,
          skipped: 0,
          messages: [],
        }),
      );
      expect(read.cursor).toEqual({
        uidvalidity: 3,
        last_uid: 200,
        dated: { to_uid: 912, since: new Date('2026-11-05T14:00:00.000Z') },
      });
    });

    it('counts a message it cannot read as skipped, and keeps the rest', async () => {
      const read = await ask(
        reply(200, {
          uidvalidity: 3,
          last_uid: 11,
          dated_to_uid: null,
          dated_since: null,
          more: false,
          skipped: 1,
          messages: [
            { uid: 10, internal_date: 'not a date', from_address: 'a@b.test', from_name: null, subject: 'x' },
            { uid: 11, internal_date: '2026-11-05T14:55:00+00:00', from_address: '', from_name: null, subject: 'x' },
            {
              uid: 12,
              internal_date: '2026-11-05T14:55:00+00:00',
              from_address: 'a@b.test',
              from_name: null,
              subject: 'y',
            },
          ],
        }),
      );
      expect(read.skipped).toBe(3);
      expect(read.messages.map(message => message.id)).toEqual(['imap:3:12']);
    });

    it('says a failed login is a login that must be redone, and an unreachable server is a busy one', async () => {
      await expect(ask(reply(502, { error: 'login_failed' }))).rejects.toBeInstanceOf(MailLoginFailedError);
      const busy = ask(reply(502, { error: 'unavailable' }));
      await expect(busy).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(busy).rejects.not.toBeInstanceOf(MailLoginFailedError);
    });

    it('says a dropped connection is a busy server and a slow answer is too slow', async () => {
      const dropped: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
      const slow: typeof fetch = () =>
        Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
      await expect(ask(dropped)).rejects.toBeInstanceOf(MailSourceBusyError);
      await expect(ask(slow)).rejects.toBeInstanceOf(MailTooSlowError);
    });

    it('passes on any other word as a plain error, which is not a busy server', async () => {
      const failure = ask(reply(409, { error: 'no_account' }));
      await expect(failure).rejects.toThrow('no_account');
      await expect(failure).rejects.not.toBeInstanceOf(MailSourceBusyError);
    });
  });

  describe('a crafted header next to a real bill', () => {
    const pass = (agent: ListAfterAgent, input: { cursor: MailCursor | undefined; out_of_time?: () => boolean }) =>
      watchMail({
        source: mailSource(billsTool(), agent),
        settings: defaultReachSettings('UTC'),
        since: SINCE,
        now: NOW,
        logger: { warn: jest.fn() },
        cursor: input.cursor,
        stuck: undefined,
        out_of_time: input.out_of_time ?? (() => false),
        assistant: 'Mira',
      });

    it('keeps the dating on the cursor when the pass stops below it, after a later call said nothing of it', async () => {
      const dated = { to_uid: 5, since: SINCE };
      const bill = (uid: number) => ({
        id: imapMessageId({ uidvalidity: 1, uid }),
        uid,
        thread_id: 'Invoice',
        from_address: 'billing@power.test',
        from_name: null,
        subject: 'Invoice: amount due by November 7',
        snippet: '',
        received_at: new Date(`2026-11-05T14:5${String(uid)}:00.000Z`),
        authentication_results: [],
      });
      const replies: CursorRead[] = [
        { messages: [bill(1), bill(2)], skipped: 0, cursor: { uidvalidity: 1, last_uid: 5, dated }, more: true },
        { messages: [], skipped: 0, cursor: { uidvalidity: 1, last_uid: 5 }, more: false },
      ];
      const agent: ListAfterAgent = () => {
        const next = replies.shift();
        return next === undefined ? Promise.reject(new Error('asked too often')) : Promise.resolve(next);
      };
      let reads = 0;
      const found = await watchMail({
        source: mailSource((name, args) => {
          if (name === 'get_emails_content') {
            reads += 1;
          }
          return billsTool()(name, args);
        }, agent),
        settings: defaultReachSettings('UTC'),
        since: SINCE,
        now: NOW,
        logger: { warn: jest.fn() },
        cursor: undefined,
        stuck: undefined,
        out_of_time: () => reads >= 1,
        assistant: 'Mira',
      });
      expect(found.cursor).toEqual({ uidvalidity: 1, last_uid: 1, dated });
    });

    it('reads the bill beside a header that does not parse, and tells of the one it could not list', async () => {
      const { agent } = mailboxAgent([
        arrival({ uid: 7, at: '2026-11-05T14:55:00.000Z', subject: 'Invoice: amount due by November 7' }),
        arrival({ uid: 8, at: '2026-11-05T14:55:01.000Z', bad: true }),
      ]);
      const found = await pass(agent, { cursor: undefined });
      expect(found.raise.map(event => event.id)).toEqual(['bill_due:imap:1:7']);
      expect(found.gaps).toHaveLength(1);
      expect(found.stopped_by).toBeUndefined();
      expect(found.resume_from).toBeUndefined();
      expect(found.cursor).toEqual({ uidvalidity: 1, last_uid: 8 });
    });

    it('does not stall on a flood of mail in a few seconds with a bad header in it (the probe that stalled the old path)', async () => {
      const flood = Array.from({ length: 120 }, (_, n) =>
        arrival({ uid: n + 1, at: `2026-11-05T14:55:0${String(n % 4)}.000Z`, subject: 'Newsletter' }),
      );
      const { agent } = mailboxAgent([
        ...flood,
        arrival({ uid: 121, at: '2026-11-05T14:55:03.000Z', bad: true }),
        arrival({ uid: 122, at: '2026-11-05T14:55:03.500Z', subject: 'Invoice: amount due by November 7' }),
      ]);
      let cursor: MailCursor | undefined;
      const raised: string[] = [];
      let passes = 0;
      for (; passes < 10; passes += 1) {
        let looks = 0;
        // Each pass has time for one list and about fifty messages.
        const found = await pass(agent, { cursor, out_of_time: () => (looks += 1) > 60 });
        raised.push(...found.raise.map(event => event.id));
        expect(found.stopped_by).toBeUndefined();
        cursor = found.cursor;
        if (found.resume_from === undefined) break;
      }
      expect(passes).toBeLessThan(10);
      expect(raised).toEqual(['bill_due:imap:1:122']);
      expect(cursor).toEqual({ uidvalidity: 1, last_uid: 122 });
    });

    it('handles 450 bill-like messages that arrived in one four second stretch, with no cap on how many', async () => {
      const bills = Array.from({ length: 450 }, (_, n) =>
        arrival({
          uid: n + 1,
          at: '2026-11-05T14:55:00.000Z',
          subject: `Invoice ${String(n)}: amount due by November 20`,
        }),
      );
      const { agent } = mailboxAgent(bills);
      let cursor: MailCursor | undefined;
      const tracked: string[] = [];
      for (let passes = 0; passes < 30; passes += 1) {
        let looks = 0;
        const found = await pass(agent, { cursor, out_of_time: () => (looks += 1) > 100 });
        tracked.push(...found.track.map(event => event.id));
        cursor = found.cursor;
        if (found.resume_from === undefined) break;
      }
      expect(tracked).toHaveLength(450);
      expect(new Set(tracked).size).toBe(450);
    });
  });

  it('treats an always-important sender as ordinary mail, so only a bill note can come of it', async () => {
    const { call } = mailTool([EMAIL], { '7': 'Amount due by November 7' });
    const { agent } = mailboxAgent([
      arrival({ uid: 7, at: '2026-11-05T14:55:00.000Z', subject: 'Your invoice: amount due by November 7' }),
    ]);
    const settings = {
      ...defaultReachSettings('UTC'),
      always_important: [
        { address: 'billing@power.test', source: 'settings' as const, added_at: '2026-11-01T00:00:00.000Z' },
      ],
    };
    const found = await watchMail({
      source: mailSource(call, agent),
      settings,
      since: new Date('2026-11-05T14:00:00.000Z'),
      now: NOW,
      logger: { warn: jest.fn() },
      stuck: undefined,
      out_of_time: () => false,
      assistant: 'Mira',
    });
    expect(found.raise.map(event => [event.kind, event.evidence])).toEqual([['bill_due', 'content']]);
  });

  it('finds a later reply by the bare subject', async () => {
    const reply = { ...EMAIL, email_id: '8', subject: 'Re: Your invoice', date: '2026-11-05T14:58:00+00:00' };
    const { call, calls } = mailTool([reply], { '8': 'Thank you for your payment' });
    const later = await mailSource(call).laterInThread({
      id: 'imap:1:7',
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
    sourcesFor: () => Promise.resolve({ mail: { status: 'none' }, calendar: { status: 'none' } }),
  };

  it('offers nothing when no sidecar is set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      mailAgent: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    await expect(provider.listOwners()).resolves.toEqual([OWNER]);
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({
      mail: { status: 'none' },
      calendar: { status: 'none' },
    });
  });

  it('keeps a person’s own Google sources over the sidecar', async () => {
    const own: NoticingSources = {
      mail: {
        status: 'ready',
        source: mailSource(mailTool([]).call),
        kind: 'google',
      },
      calendar: { status: 'none' },
    };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      mailAgent: { url: 'http://agent.invalid', secret: AGENT_SECRET },
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
      mailAgent: undefined,
      calendarUrl: 'http://calendar.invalid/mcp',
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    const second = { tenant_id: 'default', created_by: 'owner-2' };
    expect((await provider.sourcesFor(OWNER)).calendar.status).toBe('ready');
    await expect(provider.sourcesFor(second)).resolves.toEqual({
      mail: { status: 'none' },
      calendar: { status: 'none' },
    });
  });

  it('lists the instance owner so the shared connectors are watched, and no one else', async () => {
    const second = { tenant_id: 'default', created_by: 'owner-2' };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      mailAgent: { url: 'http://agent.invalid', secret: AGENT_SECRET },
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
      mailAgent: { url: 'http://agent.invalid', secret: AGENT_SECRET },
      calendarUrl: 'http://calendar.invalid/mcp',
      primary: none,
      instanceOwner: undefined,
      logger: winston.createLogger({ silent: true }),
    });
    await expect(provider.sourcesFor(OWNER)).resolves.toEqual({
      mail: { status: 'none' },
      calendar: { status: 'none' },
    });
    await expect(provider.listOwners()).resolves.toEqual([OWNER]);
  });

  it('uses the shared connector only when Google gives no mail, never in place of a Google login that must be redone', async () => {
    const reconnect: NoticingSources = {
      mail: { status: 'unreachable', error: new Error('Google needs to be connected again.'), kind: 'google' },
      calendar: { status: 'none' },
    };
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      mailAgent: { url: 'http://agent.invalid', secret: AGENT_SECRET },
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
      mailAgent: { url: 'http://agent.invalid', secret: AGENT_SECRET },
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    const sources = await provider.sourcesFor(OWNER);
    expect(sources.mail.status).toBe('unreachable');
    expect(sources.mail.status === 'unreachable' ? sources.mail.error : undefined).toBeInstanceOf(Error);
  });

  it('leaves the shared mailbox unwatched when the account agent is not set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: 'http://mail.invalid/mcp',
      mailAgent: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail).toEqual({ status: 'none' });
  });

  it('says nothing is unreachable when no mail connector is set up', async () => {
    const provider = createSidecarNoticingSources({
      mailUrl: undefined,
      mailAgent: undefined,
      calendarUrl: undefined,
      primary: none,
      instanceOwner: OWNER,
      logger: winston.createLogger({ silent: true }),
    });
    expect((await provider.sourcesFor(OWNER)).mail).toEqual({ status: 'none' });
  });
});
