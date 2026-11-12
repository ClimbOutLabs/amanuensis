import {
  renderMailAccountEnv,
  renderMailAccountsEnv,
  type MailAccount,
} from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const AGENT = resolve(REPO_ROOT, 'ops/compose/mail-email/account_agent.py');
const FAKE_IMAP = resolve(REPO_ROOT, 'installer/tests/fake_imap.py');
const ADDRESS = 'person@example.com';

/** A message as the fake IMAP server stores it. */
export interface Stored {
  uid: number;
  internal_date: string;
  header: string;
  refuse?: boolean;
  gone?: boolean;
  batch_refuse?: boolean;
}

/** The fake server's mailbox file. */
export interface StoredMailbox {
  uidvalidity: number;
  messages: Stored[];
  fetch_delay_ms?: number;
  no_uidnext?: boolean;
}

/** A message as the fake server stores it, arrived `minute` minutes after 14:00 UTC on 5 November 2026. */
export function stored({ uid, minute, header }: { uid: number; minute: number; header?: string }): Stored {
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

/** The fake IMAP server and the real account agent, signed in to it, on `port`. */
export interface MailAgentHarness {
  url: string;
  password: string;
  setMailbox: (box: StoredMailbox) => void;
  /** Every IMAP command the agent sent since the server started. */
  commands: () => string;
  saveAccount: (password: string) => void;
  /** Saves another account first in the file, with the server's own account named as the default. */
  saveBehindOtherAccount: (other: { address: string; password: string }) => void;
  /** What the agent printed. */
  output: () => string;
  stop: () => void;
}

/** Starts the fake server and the agent. The agent stops starting server calls after `list_seconds`. */
export async function startMailAgent({
  port,
  password,
  list_seconds,
}: {
  port: number;
  password: string;
  list_seconds: number;
}): Promise<MailAgentHarness> {
  const url = `http://127.0.0.1:${String(port)}`;
  const dir = mkdtempSync(join(tmpdir(), 'mail-agent-'));
  const accountFile = join(dir, '.env.mail-email');
  const mailboxFile = join(dir, 'mailbox.json');
  const setMailbox = (box: StoredMailbox) => {
    writeFileSync(mailboxFile, JSON.stringify(box));
  };
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
  const imap: ChildProcess = spawn('python3', [FAKE_IMAP, 'ssl', cert, key, ADDRESS, password, portFile, mailboxFile], {
    stdio: 'ignore',
  });
  await eventually(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim() !== '');
  const imapPort = Number(readFileSync(portFile, 'utf8').trim());
  const accountWith = ({ address, password: saved }: { address: string; password: string }): MailAccount => ({
    address,
    password: saved,
    imap_host: 'localhost',
    imap_port: imapPort,
    imap_mode: 'ssl',
    smtp_host: 'localhost',
    smtp_port: 465,
    smtp_mode: 'ssl',
  });
  const saveAccount = (saved: string) => {
    writeFileSync(accountFile, renderMailAccountEnv(accountWith({ address: ADDRESS, password: saved })), {
      mode: 0o600,
    });
  };
  const saveBehindOtherAccount = (other: { address: string; password: string }) => {
    writeFileSync(
      accountFile,
      renderMailAccountsEnv({
        accounts: [accountWith(other), accountWith({ address: ADDRESS, password })],
        default_address: ADDRESS,
      }),
      { mode: 0o600 },
    );
  };
  saveAccount(password);
  let output = '';
  const agent: ChildProcess = spawn('python3', [AGENT], {
    env: {
      ...process.env,
      AMAN_MAIL_ACCOUNT_FILE: accountFile,
      AMAN_MAIL_ACCOUNT_PORT: String(port),
      AMAN_MAIL_LIST_SECONDS: String(list_seconds),
      SSL_CERT_FILE: cert,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  agent.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let up = false;
  await eventually(() => {
    fetch(`${url}/account`)
      .then(response => {
        up = response.ok;
      })
      .catch(() => undefined);
    return up;
  });
  return {
    url,
    password,
    setMailbox,
    commands: () => {
      const file = join(dir, 'imap.port.commands');
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    saveAccount,
    saveBehindOtherAccount,
    output: () => output,
    stop: () => {
      agent.kill('SIGKILL');
      imap.kill('SIGKILL');
    },
  };
}
