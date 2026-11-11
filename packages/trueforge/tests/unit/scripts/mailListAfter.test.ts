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

  function setMailbox({ uidvalidity, messages }: { uidvalidity: number; messages: Stored[] }): void {
    writeFileSync(mailboxFile, JSON.stringify({ uidvalidity, messages }));
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
    expect(read.messages.map(message => message.id)).toEqual(['4']);
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
    expect(after.messages.map(message => message.id)).toEqual(['4']);
    const none = await list({ uidvalidity: 7, last_uid: 4, since: '2026-11-05T14:50:00.000Z', limit: 10 });
    expect(none.messages).toEqual([]);
    expect(none.cursor).toEqual({ uidvalidity: 7, last_uid: 4 });
  }, 30_000);

  it('starts again from the given time when the mailbox was renumbered', async () => {
    setMailbox({ uidvalidity: 8, messages: [stored({ uid: 1, minute: 0 }), stored({ uid: 2, minute: 30 })] });
    const read = await list({ uidvalidity: 7, last_uid: 4, since: '2026-11-05T14:10:00.000Z', limit: 10 });
    expect(read.messages.map(message => message.id)).toEqual(['2']);
    expect(read.cursor).toEqual({ uidvalidity: 8, last_uid: 2 });
  }, 30_000);

  it('lists at most the limit, says more is waiting, and goes on from there', async () => {
    const messages = Array.from({ length: 5 }, (_, n) => stored({ uid: n + 1, minute: n }));
    setMailbox({ uidvalidity: 9, messages });
    const first = await list({ uidvalidity: 9, last_uid: 0, since: '2026-11-05T14:00:00.000Z', limit: 3 });
    expect(first.messages.map(message => message.id)).toEqual(['1', '2', '3']);
    expect(first.more).toBe(true);
    const next = await list({ ...first.cursor, since: '2026-11-05T14:00:00.000Z', limit: 3 });
    expect(next.messages.map(message => message.id)).toEqual(['4', '5']);
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
    expect(read.messages.map(message => message.id)).toEqual(['1', '3']);
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
    expect(read.messages.map(message => message.id)).toEqual(['1', '3']);
    expect(read.skipped).toBe(1);
    expect(read.cursor).toEqual({ uidvalidity: 11, last_uid: 3 });
  }, 30_000);

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
