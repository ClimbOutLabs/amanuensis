/**
 * The saved email accounts and the file they live in. The installer writes the instance's
 * .env.mail-email; the Settings Email card reaches the same file through the mail sidecar's
 * account agent. This module is the one owner of the file's format: one block of keys per
 * account in the shape the installer has always written, an optional line naming the default
 * account, the single quoted password, and the header line, all mirroring the installer's
 * email_env_text. The sidecar agent renders the same bytes from the same rules, and tests pin
 * the two together.
 */
import type { MailServerMode } from './presets';

/** The port the sidecar's account agent listens on, inside the instance's private network only. */
export const MAIL_ACCOUNT_AGENT_PORT = 9559;

/** First line of the account file; the same words the installer writes. */
export const MAIL_ACCOUNT_FILE_HEADER =
  '# Written by the installer for the Email connector. Keep it private: it holds the app password.';

/** The line naming the default account, present only when a default was named. */
export const MAIL_DEFAULT_ACCOUNT_KEY = 'AMAN_MAIL_DEFAULT_ACCOUNT';

/** The key whose line starts each account's block in the file. */
const MAIL_ADDRESS_KEY = 'MCP_EMAIL_SERVER_EMAIL_ADDRESS';

/**
 * A saved email account, the whole content of the account file. The password never leaves the sidecar.
 * Which provider the person picked is not in the file (the installer's format has no such line); the
 * server works it out from the server names, which the presets own.
 */
export interface MailAccount {
  address: string;
  password: string;
  imap_host: string;
  imap_port: number;
  imap_mode: MailServerMode;
  smtp_host: string;
  smtp_port: number;
  smtp_mode: MailServerMode;
}

/** A saved account as anything outside the sidecar may see it: everything but the password. */
export type PublicMailAccount = Omit<MailAccount, 'password'>;

/** The account with the password removed, safe for status responses and the card. */
export function publicMailAccount(account: MailAccount): PublicMailAccount {
  return {
    address: account.address,
    imap_host: account.imap_host,
    imap_port: account.imap_port,
    imap_mode: account.imap_mode,
    smtp_host: account.smtp_host,
    smtp_port: account.smtp_port,
    smtp_mode: account.smtp_mode,
  };
}

function sslFlag(mode: MailServerMode): string {
  return mode === 'ssl' ? 'true' : 'false';
}

function startTlsFlag(mode: MailServerMode): string {
  return mode === 'starttls' ? 'true' : 'false';
}

/** One account's lines in the file, without the header. */
function mailAccountBlockLines(account: MailAccount): string[] {
  return [
    `MCP_EMAIL_SERVER_EMAIL_ADDRESS=${account.address}`,
    `MCP_EMAIL_SERVER_PASSWORD='${account.password}'`,
    `MCP_EMAIL_SERVER_IMAP_HOST=${account.imap_host}`,
    `MCP_EMAIL_SERVER_IMAP_PORT=${String(account.imap_port)}`,
    `MCP_EMAIL_SERVER_IMAP_SSL=${sslFlag(account.imap_mode)}`,
    `MCP_EMAIL_SERVER_IMAP_START_SSL=${startTlsFlag(account.imap_mode)}`,
    'MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true',
    `MCP_EMAIL_SERVER_SMTP_HOST=${account.smtp_host}`,
    `MCP_EMAIL_SERVER_SMTP_PORT=${String(account.smtp_port)}`,
    `MCP_EMAIL_SERVER_SMTP_SSL=${sslFlag(account.smtp_mode)}`,
    `MCP_EMAIL_SERVER_SMTP_START_SSL=${startTlsFlag(account.smtp_mode)}`,
    'MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true',
  ];
}

/**
 * The account file's exact text for one account, byte for byte what the installer's
 * email_env_text writes for the same account, so the installer and the Settings card can
 * read each other's files.
 */
export function renderMailAccountEnv(account: MailAccount): string {
  return `${[MAIL_ACCOUNT_FILE_HEADER, ...mailAccountBlockLines(account)].join('\n')}\n`;
}

/** Every saved account in the file, and the default account's address when one was named. */
export interface MailAccountList {
  accounts: MailAccount[];
  /** The named default's address, or null when no default was named; the first account is then the default. */
  default_address: string | null;
}

/**
 * The account file's exact text for a list of accounts. A default line is written only when a
 * default was named, so a file holding one account with no named default keeps the bytes it has
 * always had, and an empty list is an empty file.
 */
export function renderMailAccountsEnv(list: MailAccountList): string {
  if (list.accounts.length === 0) {
    return '';
  }
  const lines = [MAIL_ACCOUNT_FILE_HEADER];
  if (list.default_address !== null) {
    lines.push(`${MAIL_DEFAULT_ACCOUNT_KEY}=${list.default_address}`);
  }
  for (const account of list.accounts) {
    lines.push(...mailAccountBlockLines(account));
  }
  return `${lines.join('\n')}\n`;
}

/** The account a send goes from when none is named: the named default, else the first account. */
export function defaultMailAccount(list: MailAccountList): MailAccount | null {
  const named = list.accounts.find(account => account.address === list.default_address);
  return named ?? list.accounts[0] ?? null;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

function modeFromFlags(ssl: string | undefined): MailServerMode {
  return ssl === 'true' ? 'ssl' : 'starttls';
}

function portFrom(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** One account from a block's key values, or null when the block is not a complete account. */
function mailAccountFromValues(values: ReadonlyMap<string, string>): MailAccount | null {
  const address = values.get('MCP_EMAIL_SERVER_EMAIL_ADDRESS');
  const password = values.get('MCP_EMAIL_SERVER_PASSWORD');
  const imapHost = values.get('MCP_EMAIL_SERVER_IMAP_HOST');
  const smtpHost = values.get('MCP_EMAIL_SERVER_SMTP_HOST');
  const imapPort = portFrom(values.get('MCP_EMAIL_SERVER_IMAP_PORT'));
  const smtpPort = portFrom(values.get('MCP_EMAIL_SERVER_SMTP_PORT'));
  if (
    address === undefined ||
    address === '' ||
    password === undefined ||
    password === '' ||
    imapHost === undefined ||
    imapHost === '' ||
    smtpHost === undefined ||
    smtpHost === '' ||
    imapPort === null ||
    smtpPort === null
  ) {
    return null;
  }
  return {
    address,
    password,
    imap_host: imapHost,
    imap_port: imapPort,
    imap_mode: modeFromFlags(values.get('MCP_EMAIL_SERVER_IMAP_SSL')),
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_mode: modeFromFlags(values.get('MCP_EMAIL_SERVER_SMTP_SSL')),
  };
}

/**
 * Reads an account file's text back into its accounts. Each block starts at its address line,
 * the shape the file has always had, so a file holding one account reads as a one-entry list.
 * A block that is not a complete account is left out rather than hiding the accounts that are
 * complete. Unknown lines are ignored, as Docker's env_file reader ignores them.
 */
export function parseMailAccountsEnv(text: string): MailAccountList {
  let defaultAddress: string | null = null;
  const blocks: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = unquote(trimmed.slice(eq + 1));
    if (key === MAIL_DEFAULT_ACCOUNT_KEY) {
      defaultAddress = value;
      continue;
    }
    if (key === MAIL_ADDRESS_KEY) {
      current = new Map<string, string>();
      blocks.push(current);
    }
    if (current === null) {
      continue;
    }
    current.set(key, value);
  }
  const accounts: MailAccount[] = [];
  for (const block of blocks) {
    const account = mailAccountFromValues(block);
    if (account !== null) {
      accounts.push(account);
    }
  }
  return { accounts, default_address: defaultAddress };
}

/**
 * Reads an account file's text back into its first account, or null when the file holds no
 * complete account (missing, empty, or partly written).
 */
export function parseMailAccountEnv(text: string): MailAccount | null {
  return parseMailAccountsEnv(text).accounts[0] ?? null;
}
