import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  MAIL_ACCOUNT_FILE_HEADER,
  parseMailAccountEnv,
  publicMailAccount,
  renderMailAccountEnv,
  type MailAccount,
} from '../../../../src/core/email/mailConnector/accountFile';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

const ACCOUNT: MailAccount = {
  address: 'person@example.com',
  password: 'canary-password-1234',
  imap_host: 'imap.example.com',
  imap_port: 993,
  imap_mode: 'ssl',
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_mode: 'starttls',
};

const EXPECTED_TEXT = [
  '# Written by the installer for the Email connector. Keep it private: it holds the app password.',
  'MCP_EMAIL_SERVER_EMAIL_ADDRESS=person@example.com',
  `MCP_EMAIL_SERVER_PASSWORD='${ACCOUNT.password}'`,
  'MCP_EMAIL_SERVER_IMAP_HOST=imap.example.com',
  'MCP_EMAIL_SERVER_IMAP_PORT=993',
  'MCP_EMAIL_SERVER_IMAP_SSL=true',
  'MCP_EMAIL_SERVER_IMAP_START_SSL=false',
  'MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true',
  'MCP_EMAIL_SERVER_SMTP_HOST=smtp.example.com',
  'MCP_EMAIL_SERVER_SMTP_PORT=587',
  'MCP_EMAIL_SERVER_SMTP_SSL=false',
  'MCP_EMAIL_SERVER_SMTP_START_SSL=true',
  'MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true',
  '',
].join('\n');

/** The installer's own email_env_text output for the same account, from installer/lib/email.sh. */
function installerEnvText(account: MailAccount): string {
  const script = [
    'source "$1"',
    'EM_ADDRESS=$2 EM_PASSWORD=$3 EM_IMAP_HOST=$4 EM_IMAP_PORT=$5 EM_IMAP_MODE=$6 EM_SMTP_HOST=$7 EM_SMTP_PORT=$8 EM_SMTP_MODE=$9 email_env_text',
  ].join('\n');
  return execFileSync(
    'bash',
    [
      '-c',
      script,
      'test',
      resolve(REPO_ROOT, 'installer/lib/email.sh'),
      account.address,
      account.password,
      account.imap_host,
      String(account.imap_port),
      account.imap_mode,
      account.smtp_host,
      String(account.smtp_port),
      account.smtp_mode,
    ],
    { encoding: 'utf8' },
  );
}

describe('the mail account file format', () => {
  it('renders the exact text the installer writes', () => {
    expect(renderMailAccountEnv(ACCOUNT)).toBe(EXPECTED_TEXT);
    expect(installerEnvText(ACCOUNT)).toBe(EXPECTED_TEXT);
    expect(MAIL_ACCOUNT_FILE_HEADER).toBe(EXPECTED_TEXT.split('\n')[0]);
  });

  it('parses its own rendering back to the account', () => {
    expect(parseMailAccountEnv(renderMailAccountEnv(ACCOUNT))).toEqual(ACCOUNT);
  });

  it('parses a file the installer wrote, quotes and all', () => {
    expect(parseMailAccountEnv(installerEnvText(ACCOUNT))).toEqual(ACCOUNT);
  });

  it('reads both mode flags', () => {
    const starttlsFirst: MailAccount = { ...ACCOUNT, imap_mode: 'starttls', smtp_mode: 'ssl' };
    expect(parseMailAccountEnv(renderMailAccountEnv(starttlsFirst))).toEqual(starttlsFirst);
  });

  it('returns null for an empty or incomplete file', () => {
    expect(parseMailAccountEnv('')).toBeNull();
    expect(parseMailAccountEnv('# only a comment\n')).toBeNull();
    expect(parseMailAccountEnv('MCP_EMAIL_SERVER_EMAIL_ADDRESS=person@example.com\n')).toBeNull();
    expect(
      parseMailAccountEnv(
        EXPECTED_TEXT.replace(`MCP_EMAIL_SERVER_PASSWORD='${ACCOUNT.password}'`, 'MCP_EMAIL_SERVER_PASSWORD='),
      ),
    ).toBeNull();
  });

  it('the public view never carries the password', () => {
    const view = publicMailAccount(ACCOUNT);
    expect(JSON.stringify(view)).not.toContain(ACCOUNT.password);
    expect(view.address).toBe(ACCOUNT.address);
  });
});
