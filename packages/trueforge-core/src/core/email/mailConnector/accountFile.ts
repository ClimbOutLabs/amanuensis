/**
 * The saved email account and the file it lives in. The installer writes the instance's
 * .env.mail-email; the Settings Email card reaches the same file through the mail sidecar's
 * account agent. This module is the one owner of the file's format: the exact keys, the single
 * quoted password, and the header line, all mirroring the installer's email_env_text. The sidecar
 * agent renders the same bytes from the same rules, and tests pin the two together.
 */
import type { MailServerMode } from './presets';

/** The port the sidecar's account agent listens on, inside the instance's private network only. */
export const MAIL_ACCOUNT_AGENT_PORT = 9559;

/** First line of the account file; the same words the installer writes. */
export const MAIL_ACCOUNT_FILE_HEADER =
  '# Written by the installer for the Email connector. Keep it private: it holds the app password.';

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

/**
 * The account file's exact text, byte for byte what the installer's email_env_text writes for the
 * same account, so the installer and the Settings card can read each other's files.
 */
export function renderMailAccountEnv(account: MailAccount): string {
  const lines = [
    MAIL_ACCOUNT_FILE_HEADER,
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
  return `${lines.join('\n')}\n`;
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

/**
 * Reads an account file's text back into an account, or null when the file holds no complete
 * account (missing, empty, or partly written). Unknown lines are ignored, as Docker's env_file
 * reader ignores them.
 */
export function parseMailAccountEnv(text: string): MailAccount | null {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    values.set(trimmed.slice(0, eq), unquote(trimmed.slice(eq + 1)));
  }
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
