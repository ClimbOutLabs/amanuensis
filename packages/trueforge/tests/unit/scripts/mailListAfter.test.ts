import { renderMailAccountEnv } from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { imapAgent } from '../../../src/runtime/noticing/sidecarSources';
import { MailLoginFailedError } from '../../../src/runtime/noticing/sources';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const AGENT = resolve(REPO_ROOT, 'ops/compose/mail-email/account_agent.py');
const FAKE_IMAP = resolve(REPO_ROOT, 'installer/tests/fake_imap.py');

const PASSWORD = 'CANARY-LIST-PASSWORD-4k2q';
const AGENT_PORT = 19775;
const ADDRESS = 'person@example.com';
const URL = `http://127.0.0.1:${String(AGENT_PORT)}`;

interface Stored {
  uid: number;
  internal_date: string;
  header: string;
  refuse?: boolean;
  gone?: boolean;
  batch_refuse?: boolean;
}

/** A message as the fake server stores it, arrived `minute` minutes after 14:00 UTC on 5 November 2026. */
function stored({ uid, minute, header }: { uid: number; minute: number; header?: string }): Stored {
  const time = `${String(14 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
  return {
    uid,
    internal_date: `05-Nov-2026 ${time} +0000`,
    header: header ?? `From: Power Co <billing@power.test>\nSubject: Invoice ${String(uid)}`,
  };
}

async function eventually(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
}

describe('the mail account agent lists new mail by number', () => {
  let dir: string;
  let mailboxFile: string;
  let accountFile: string;
  let imapPort: number;
  let imap: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  let agentOutput = '';
  const list = imapAgent({ url: URL, fetchImpl: undefined });

  function setMailbox({
    uidvalidity,
    messages,
    fetch_delay_ms = 0,
  }: {
    uidvalidity: number;
    messages: Stored[];
    fetch_delay_ms?: number;
  }): void {
    writeFileSync(mailboxFile, JSON.stringify({ uidvalidity, messages, fetch_delay_ms }));
  }

  function saveAccount(password: string): void {
    writeFileSync(
      accountFile,
      renderMailAccountEnv({
        address: ADDRESS,
        password,
        imap_host: 'localhost',
        imap_port: imapPort,
        imap_mode: 'ssl',
        smtp_host: 'localhost',
        smtp_port: 465,
        smtp_mode: 'ssl',
      }),
      { mode: 0o600 },
    );
  }

  const commands = (): string => {
    const file = join(dir, 'imap.port.commands');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-list-'));
    accountFile = join(dir, '.env.mail-email');
    mailboxFile = join(dir, 'mailbox.json');
    setMailbox({ uidvalidity: 1, messages: [] });
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const portFile = join(dir, 'imap.port');
    imap = spawn('python3', [FAKE_IMAP, 'ssl', cert, key, ADDRESS, PASSWORD, portFile, mailboxFile], {
      stdio: 'ignore',
    });
    await eventually(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim() !== '');
    imapPort = Number(readFileSync(portFile, 'utf8').trim());
    saveAccount(PASSWORD);
    agent = spawn('python3', [AGENT], {
      env: {
        ...process.env,
        AMAN_MAIL_ACCOUNT_FILE: accountFile,
        AMAN_MAIL_ACCOUNT_PORT: String(AGENT_PORT),
        // Short, so a test can see the work stop in time; every call still gets through at least one message.
        AMAN_MAIL_LIST_SECONDS: '2',
        SSL_CERT_FILE: cert,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout?.on('data', (chunk: Buffer) => {
      agentOutput += chunk.toString();
    });
    agent.stderr?.on('data', (chunk: Buffer) => {
      agentOutput += chunk.toString();
    });
    let up = false;
    await eventually(() => {
      fetch(`${URL}/account`)
        .then(response => {
          up = response.ok;
        })
        .catch(() => undefined);
      return up;
    });
  }, 60_000);

  afterAll(() => {
    agent?.kill('SIGKILL');
    imap?.kill('SIGKILL');
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
    expect(read.cursor).toEqual({ uidvalidity: 7, last_uid: 4 });
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
    expect(read.cursor).toEqual({ uidvalidity: 8, last_uid: 2 });
  }, 30_000);

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
    expect(alone).toEqual(['UID FETCH 2 (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])']);
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
    let cursor = { uidvalidity: 16, last_uid: 0 };
    const seen: number[] = [];
    let calls = 0;
    let more = true;
    while (more && calls < 20) {
      const started = Date.now();
      const read = await list({ ...cursor, since: '2026-11-05T14:00:00.000Z', limit: 12 });
      expect(Date.now() - started).toBeLessThan(6_000);
      seen.push(...read.messages.map(message => message.uid));
      cursor = read.cursor;
      more = read.more;
      calls += 1;
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }, 120_000);

  it('opens the inbox read-only, fetches headers without marking mail read, and never fetches a body', () => {
    const sent = commands();
    expect(sent).toContain('EXAMINE INBOX');
    expect(sent).not.toMatch(/^SELECT /m);
    expect(sent).not.toMatch(/STORE|EXPUNGE/);
    expect(sent).toContain('BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]');
    expect(sent).not.toMatch(/BODY\[(?!HEADER)/);
  });

  it('says a refused sign-in in fixed words, and never prints the password', async () => {
    saveAccount('CANARY-WRONG-LIST-PASSWORD');
    await expect(
      list({ uidvalidity: null, last_uid: null, since: '2026-11-05T14:00:00.000Z', limit: 10 }),
    ).rejects.toBeInstanceOf(MailLoginFailedError);
    saveAccount(PASSWORD);
    expect(agentOutput).not.toContain(PASSWORD);
    expect(agentOutput).not.toContain('CANARY-WRONG-LIST-PASSWORD');
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
