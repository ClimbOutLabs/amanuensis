import type { MailCursor } from '../../../src/db/noticingStore';
import { imapAgent, imapMailboxValidity, type ListAfterAgent } from '../../../src/runtime/noticing/sidecarSources';
import { MailLoginFailedError } from '../../../src/runtime/noticing/sources';
import { startMailAgent, stored, type MailAgentHarness, type Stored, MAIL_AGENT_SECRET } from './mailAgentSupport';

const PASSWORD = 'CANARY-LIST-PASSWORD-4k2q';
const PORT = 19775;
const URL = `http://127.0.0.1:${String(PORT)}`;

describe('the mail account agent lists new mail by number', () => {
  let harness: MailAgentHarness | undefined;
  const ask = imapAgent({ url: URL, secret: MAIL_AGENT_SECRET, fetchImpl: undefined });
  /** A list request with no part of the mailbox still to be dated, unless the test says otherwise. */
  const list = (request: Omit<Parameters<ListAfterAgent>[0], 'dated_to_uid' | 'dated_since'>) =>
    ask({ dated_to_uid: null, dated_since: null, ...request });
  /** The request that goes on from a cursor, as the mail source makes it. */
  const after = (cursor: MailCursor) => ({
    uidvalidity: cursor.uidvalidity,
    last_uid: cursor.last_uid,
    dated_to_uid: cursor.dated?.to_uid ?? null,
    dated_since: cursor.dated?.since.toISOString() ?? null,
  });
  const validity = imapMailboxValidity({ url: URL, secret: MAIL_AGENT_SECRET, fetchImpl: undefined });

  function setMailbox(box: { uidvalidity: number; messages: Stored[]; fetch_delay_ms?: number; no_uidnext?: boolean }) {
    harness?.setMailbox(box);
  }
  const saveAccount = (password: string) => harness?.saveAccount(password);
  const commands = (): string => harness?.commands() ?? '';

  beforeAll(async () => {
    // Short, so a test can see the work stop in time; every call still gets through at least one message.
    harness = await startMailAgent({ port: PORT, password: PASSWORD, list_seconds: 2 });
  }, 60_000);

  afterAll(() => {
    harness?.stop();
  });

  it('starts at the mail that arrived since the given time, and says where it got to', async () => {
    setMailbox({ uidvalidity: 7, messages: [stored({ uid: 3, minute: 0 }), stored({ uid: 4, minute: 30 })] });
    const read = await list({ uidvalidity: null, last_uid: null, since: '2026-11-05T14:10:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([4]);
    expect(read.messages[0]).toMatchObject({
      from_address: 'billing@power.test',
      from_name: 'Power Co',
      subject: 'Invoice 4',
      received_at: new Date('2026-11-05T14:30:00.000Z'),
    });
    // The dated UIDs come back with the cursor, though all are behind it, for a pass that stops earlier.
    expect(read.cursor).toEqual({
      uidvalidity: 7,
      last_uid: 4,
      dated: { to_uid: 4, since: new Date('2026-11-05T14:10:00.000Z') },
    });
    expect(read.more).toBe(false);
  }, 30_000);

  it('lists only the mail after the cursor, and stays put when nothing is new', async () => {
    setMailbox({ uidvalidity: 7, messages: [stored({ uid: 3, minute: 0 }), stored({ uid: 4, minute: 30 })] });
    const after = await list({ uidvalidity: 7, last_uid: 3, since: '2026-11-05T14:50:00.000Z', limit: 10 });
    expect(after.messages.map(message => message.uid)).toEqual([4]);
    const none = await list({ uidvalidity: 7, last_uid: 4, since: '2026-11-05T14:50:00.000Z', limit: 10 });
    expect(none.messages).toEqual([]);
    expect(none.cursor).toEqual({ uidvalidity: 7, last_uid: 4 });
  }, 30_000);

  it('starts again from the given time when the mailbox was renumbered', async () => {
    setMailbox({ uidvalidity: 8, messages: [stored({ uid: 1, minute: 0 }), stored({ uid: 2, minute: 30 })] });
    const read = await list({ uidvalidity: 7, last_uid: 4, since: '2026-11-05T14:10:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([2]);
    expect(read.cursor).toEqual({
      uidvalidity: 8,
      last_uid: 2,
      dated: { to_uid: 2, since: new Date('2026-11-05T14:10:00.000Z') },
    });
  }, 30_000);

  it('dates the mail already in the mailbox when the server gives no UIDNEXT, by its highest UID', async () => {
    setMailbox({
      uidvalidity: 19,
      messages: [stored({ uid: 3, minute: 0 }), stored({ uid: 4, minute: 30 })],
      no_uidnext: true,
    });
    const read = await list({ uidvalidity: null, last_uid: null, since: '2026-11-05T14:10:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([4]);
  }, 30_000);

  it('reads the Message-ID and Date headers as sent, unfolded, so odd values stay apart', async () => {
    const header = (id: string) =>
      `From: Power Co <billing@power.test>\nSubject: Invoice\nDate: Thu, 5 Nov 2026\n 14:30:00 +0000\nMessage-ID: ${id}`;
    setMailbox({
      uidvalidity: 20,
      messages: [
        { ...stored({ uid: 1, minute: 30 }), header: header('<ünï cødé "q" ;,@x.test>') },
        { ...stored({ uid: 2, minute: 30 }), header: header('<ünï other@x.test>') },
      ],
    });
    const response = await fetch(`${URL}/list_after`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uidvalidity: null, last_uid: null, since: '2026-11-05T14:10:00.000Z', limit: 10 }),
    });
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      messages: [
        { uid: 1, message_id: '<ünï cødé "q" ;,@x.test>', date: 'Thu, 5 Nov 2026 14:30:00 +0000' },
        { uid: 2, message_id: '<ünï other@x.test>' },
      ],
    });
  }, 30_000);

  it('says the inbox UIDVALIDITY now, so a UID kept from another numbering is not trusted', async () => {
    setMailbox({ uidvalidity: 11, messages: [stored({ uid: 1, minute: 5 })] });
    await expect(validity()).resolves.toBe(11);
    setMailbox({ uidvalidity: 12, messages: [stored({ uid: 1, minute: 5 })] });
    await expect(validity()).resolves.toBe(12);
  });

  it('lists at most the limit, says more is waiting, and goes on from there', async () => {
    const messages = Array.from({ length: 5 }, (_, n) => stored({ uid: n + 1, minute: n }));
    setMailbox({ uidvalidity: 9, messages });
    const first = await list({ uidvalidity: 9, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 3 });
    expect(first.messages.map(message => message.uid)).toEqual([1, 2, 3]);
    expect(first.more).toBe(true);
    const next = await list({ ...first.cursor, since: '2026-11-05T14:00:00.000Z', limit: 3 });
    expect(next.messages.map(message => message.uid)).toEqual([4, 5]);
    expect(next.more).toBe(false);
  }, 30_000);

  it('costs a header that does not read only that one message, and moves past it', async () => {
    setMailbox({
      uidvalidity: 10,
      messages: [
        stored({ uid: 1, minute: 0 }),
        stored({ uid: 2, minute: 1, header: 'From: =?broken\nSubject: (' }),
        stored({ uid: 3, minute: 2 }),
      ],
    });
    const read = await list({ uidvalidity: 10, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([1, 3]);
    expect(read.skipped).toBe(1);
    expect(read.cursor).toEqual({ uidvalidity: 10, last_uid: 3 });
  }, 30_000);

  it('asks for each message alone when the server refuses a batch, and skips only the one it cannot give', async () => {
    setMailbox({
      uidvalidity: 11,
      messages: [
        stored({ uid: 1, minute: 0 }),
        { ...stored({ uid: 2, minute: 1 }), refuse: true },
        stored({ uid: 3, minute: 2 }),
      ],
    });
    const read = await list({ uidvalidity: 11, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([1, 3]);
    expect(read.skipped).toBe(1);
    expect(read.cursor).toEqual({ uidvalidity: 11, last_uid: 3 });
  }, 30_000);

  it('lists by UID after the cursor when UIDs sit above the message count, as after deletions or archiving', async () => {
    // A mailbox that once held 100 messages, most archived: five remain, numbered 96 to 100, and five bills are new.
    const kept = Array.from({ length: 5 }, (_, n) => stored({ uid: 96 + n, minute: n }));
    const bills = Array.from({ length: 5 }, (_, n) => stored({ uid: 101 + n, minute: 10 + n }));
    setMailbox({ uidvalidity: 12, messages: [...kept, ...bills] });
    const read = await list({ uidvalidity: 12, last_uid: 100, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([101, 102, 103, 104, 105]);
    expect(read.cursor).toEqual({ uidvalidity: 12, last_uid: 105 });
    const next = await list({ ...read.cursor, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(next.messages).toEqual([]);
    expect(commands()).toContain('UID SEARCH UID 101:*');
  }, 30_000);

  it('keeps what a refused batch did return, and asks only for the missing message alone', async () => {
    setMailbox({
      uidvalidity: 13,
      messages: [
        stored({ uid: 1, minute: 0 }),
        { ...stored({ uid: 2, minute: 1 }), refuse: true },
        stored({ uid: 3, minute: 2 }),
      ],
    });
    const before = commands().length;
    const read = await list({ uidvalidity: 13, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([1, 3]);
    expect(read.skipped).toBe(1);
    const alone = commands()
      .slice(before)
      .split('\n')
      .filter(line => /^UID FETCH \d+ /.test(line));
    expect(alone).toEqual(['UID FETCH 2 (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])']);
  }, 30_000);

  it('does not count a message deleted between the search and the fetch as one it could not read', async () => {
    setMailbox({
      uidvalidity: 14,
      messages: [stored({ uid: 1, minute: 0 }), { ...stored({ uid: 2, minute: 1 }), gone: true }],
    });
    const read = await list({ uidvalidity: 14, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([1]);
    expect(read.skipped).toBe(0);
    expect(read.cursor).toEqual({ uidvalidity: 14, last_uid: 2 });
  }, 30_000);

  it('lists at most 500 in one call, whatever limit is asked for', async () => {
    const messages = Array.from({ length: 600 }, (_, n) => stored({ uid: n + 1, minute: n % 60 }));
    setMailbox({ uidvalidity: 15, messages });
    const response = await fetch(`${URL}/list_after`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uidvalidity: 15, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 1000 }),
    });
    const body: unknown = await response.json();
    expect(body).toMatchObject({ uidvalidity: 15, last_uid: 500, more: true });
    expect(body).toHaveProperty('messages.length', 500);
  }, 30_000);

  it('answers in time with what it got through when one-by-one fetches are slow, and goes on from there', async () => {
    // Every message is left out of a batch, so each is asked alone, and each ask takes 0.4 s against a 2 s budget.
    const messages = Array.from({ length: 12 }, (_, n) => ({
      ...stored({ uid: n + 1, minute: n }),
      refuse: n === 0,
      batch_refuse: true,
    }));
    setMailbox({ uidvalidity: 16, messages, fetch_delay_ms: 400 });
    let cursor: MailCursor = { uidvalidity: 16, last_uid: 0 };
    const seen: number[] = [];
    let calls = 0;
    let more = true;
    while (more && calls < 20) {
      const started = Date.now();
      const read = await ask({ ...after(cursor), since: '2026-11-05T14:00:00.000Z', limit: 12 });
      expect(Date.now() - started).toBeLessThan(6_000);
      seen.push(...read.messages.map(message => message.uid));
      cursor = read.cursor;
      more = read.more;
      calls += 1;
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }, 120_000);

  it('asks for at least one message alone even when a refused batch used up the time, so every call moves on', async () => {
    const messages = [1, 2, 3].map(uid => ({ ...stored({ uid, minute: uid }), batch_refuse: true }));
    setMailbox({ uidvalidity: 18, messages, fetch_delay_ms: 2500 });
    const read = await list({ uidvalidity: 18, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.uid)).toEqual([1]);
    expect(read.cursor.last_uid).toBe(1);
    expect(read.more).toBe(true);
  }, 30_000);

  it('holds the mail it had no time to date to the same start, so old mail is never listed as new', async () => {
    // Old mail that takes more than one slow call to date, and a few new messages after it.
    const old = Array.from({ length: 450 }, (_, n) => ({
      ...stored({ uid: n + 1, minute: 0 }),
      internal_date: '05-Nov-2026 10:00:00 +0000',
    }));
    const fresh = [451, 452, 453].map(uid => stored({ uid, minute: 30 }));
    setMailbox({ uidvalidity: 17, messages: [...old, ...fresh], fetch_delay_ms: 1500 });
    const since = '2026-11-05T14:10:00.000Z';
    let read = await list({ uidvalidity: null, last_uid: null, since, limit: 500 });
    expect(read.more).toBe(true);
    expect(read.cursor.dated).toEqual({ to_uid: 453, since: new Date(since) });
    const seen = read.messages.map(message => message.uid);
    let calls = 1;
    while (read.more && calls < 20) {
      // Later calls give a later start, as the pass does after a message; the mail being dated keeps its own.
      read = await ask({ ...after(read.cursor), since: '2026-11-05T14:40:00.000Z', limit: 500 });
      seen.push(...read.messages.map(message => message.uid));
      calls += 1;
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toEqual([451, 452, 453]);
    expect(read.cursor).toMatchObject({ uidvalidity: 17, last_uid: 453 });
  }, 120_000);

  it('opens the inbox read-only, fetches headers without marking mail read, and never fetches a body', () => {
    const sent = commands();
    expect(sent).toContain('EXAMINE INBOX');
    expect(sent).not.toMatch(/^SELECT /m);
    expect(sent).not.toMatch(/STORE|EXPUNGE/);
    expect(sent).toContain('BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]');
    expect(sent).not.toMatch(/BODY\[(?!HEADER)/);
  });

  it('says a refused sign-in in fixed words, and never prints the password', async () => {
    saveAccount('CANARY-WRONG-LIST-PASSWORD');
    await expect(
      list({ uidvalidity: null, last_uid: null, since: '2026-11-05T14:00:00.000Z', limit: 10 }),
    ).rejects.toBeInstanceOf(MailLoginFailedError);
    saveAccount(PASSWORD);
    expect(harness?.output()).not.toContain(PASSWORD);
    expect(harness?.output()).not.toContain('CANARY-WRONG-LIST-PASSWORD');
  }, 30_000);

  it('refuses a request it cannot read', async () => {
    const response = await fetch(`${URL}/list_after`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uidvalidity: null, last_uid: null, since: 'soon', limit: 10 }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid' });
  }, 30_000);
});
