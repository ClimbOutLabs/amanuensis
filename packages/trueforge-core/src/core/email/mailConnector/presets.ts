/**
 * The email provider presets: the one table both the installer and the Settings Email card read.
 * The installer's copy lives in installer/lib/email.sh (EMAIL_PRESETS); a test in this package
 * parses that table and fails if the two ever drift. Nothing here is stored; a preset only fills
 * in the server names, ports and modes for a provider the person picks.
 */

export type MailServerMode = 'ssl' | 'starttls';

export interface EmailProviderPreset {
  /** Stable key, the same word the installer uses: gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde. */
  key: string;
  /** The name the person sees in the picker. */
  name: string;
  imap_host: string;
  imap_port: number;
  imap_mode: MailServerMode;
  smtp_host: string;
  smtp_port: number;
  smtp_mode: MailServerMode;
  /**
   * The provider's own help page for making an app password, checked by hand when it was added.
   * Null when no official page could be checked (web.de's help is not reachable from here), so the
   * card shows the hint without a link rather than guessing an address.
   */
  help_url: string | null;
  /** One plain sentence on how to get an app password; the same words the installer prints. */
  help_hint: string;
}

export const EMAIL_PROVIDER_PRESETS: readonly EmailProviderPreset[] = [
  {
    key: 'gmail',
    name: 'Gmail',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://support.google.com/accounts/answer/185833',
    help_hint: 'Gmail: turn on 2-Step Verification, then make an app password under Security, App passwords.',
  },
  {
    key: 'yahoo',
    name: 'Yahoo',
    imap_host: 'imap.mail.yahoo.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.mail.yahoo.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://help.yahoo.com/kb/SLN15241.html',
    help_hint: 'Yahoo: make an app password under Account Security, Generate app password.',
  },
  {
    key: 'aol',
    name: 'AOL',
    imap_host: 'imap.aol.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.aol.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://help.aol.com/articles/Create-and-manage-app-password',
    help_hint: 'AOL: make an app password under Account Security, Generate app password.',
  },
  {
    key: 'icloud',
    name: 'iCloud',
    imap_host: 'imap.mail.me.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.mail.me.com',
    smtp_port: 587,
    smtp_mode: 'starttls',
    help_url: 'https://support.apple.com/en-us/102654',
    help_hint: 'iCloud: make an app-specific password at account.apple.com under Sign-In and Security.',
  },
  {
    key: 'fastmail',
    name: 'Fastmail',
    imap_host: 'imap.fastmail.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.fastmail.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
    help_hint: 'Fastmail: make an app password under Settings, Privacy & Security, Manage app passwords.',
  },
  {
    key: 'zoho',
    name: 'Zoho',
    imap_host: 'imap.zoho.com',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.zoho.com',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html',
    help_hint: 'Zoho: turn on two-factor authentication, then make an app password under Security, App passwords.',
  },
  {
    key: 'gmx',
    name: 'GMX',
    imap_host: 'imap.gmx.net',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'mail.gmx.net',
    smtp_port: 465,
    smtp_mode: 'ssl',
    help_url: 'https://support.gmx.com/security/2fa/application-specific-passwords.html',
    help_hint:
      'GMX: turn on two-factor authentication, then make an application-specific password under Security Options.',
  },
  {
    key: 'webde',
    name: 'web.de',
    imap_host: 'imap.web.de',
    imap_port: 993,
    imap_mode: 'ssl',
    smtp_host: 'smtp.web.de',
    smtp_port: 587,
    smtp_mode: 'starttls',
    help_url: null,
    help_hint:
      'web.de: turn on two-factor authentication, then make an application-specific password under Security Options.',
  },
];

/** The preset for a key, or undefined when the key names no known provider. */
export function emailProviderPreset(key: string): EmailProviderPreset | undefined {
  return EMAIL_PROVIDER_PRESETS.find(preset => preset.key === key);
}

/**
 * The provider a saved account belongs to, worked out from its server names: the preset whose
 * incoming and outgoing servers both match, or 'other' when none does. The account file does not
 * record the provider (the installer's format has no such line), so the hosts are the record.
 */
export function mailProviderKeyForHosts(hosts: { imap_host: string; smtp_host: string }): string {
  const match = EMAIL_PROVIDER_PRESETS.find(
    preset => preset.imap_host === hosts.imap_host && preset.smtp_host === hosts.smtp_host,
  );
  return match?.key ?? 'other';
}

/**
 * The mode for a server the person typed themselves, from its port alone. Mirrors the installer's
 * email_other_modes: port 993 is direct TLS for incoming mail, port 465 for outgoing; any other
 * port starts plain and upgrades with STARTTLS.
 */
export function mailModeForCustomPort(kind: 'imap' | 'smtp', port: number): MailServerMode {
  if (kind === 'imap') {
    return port === 993 ? 'ssl' : 'starttls';
  }
  return port === 465 ? 'ssl' : 'starttls';
}

/**
 * The providers whose app passwords are shown grouped in fours: spaces are display only and are
 * stripped before the password is checked or saved. Mirrors the installer's email_clean_password,
 * which cleans for exactly these providers.
 */
const SPACE_STRIPPED_PROVIDERS: ReadonlySet<string> = new Set(['gmail', 'icloud', 'yahoo', 'aol', 'fastmail']);

/** The password as it is checked and saved: display spaces removed for the providers that group them. */
export function cleanMailPassword(input: { provider_key: string; password: string }): string {
  return SPACE_STRIPPED_PROVIDERS.has(input.provider_key) ? input.password.replaceAll(' ', '') : input.password;
}

/**
 * Why an app password cannot be saved, in plain words, or null when it can. Mirrors the installer's
 * email_secret_problem checks and wording: an empty password, characters that cannot be printed,
 * and a single quote (the account file quotes the password with single quotes).
 */
export function mailPasswordProblem(password: string): string | null {
  if (password === '') {
    return 'The app password was empty, so nothing was saved.';
  }
  if (/[^\x20-\x7E]/.test(password)) {
    return 'That app password has characters that cannot be saved. Copy it again and try again.';
  }
  if (password.includes("'")) {
    return 'That app password has a character that cannot be saved. Make a new app password and try again.';
  }
  return null;
}

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why an address cannot be used, in plain words, or null when it looks like an email address. */
export function mailAddressProblem(address: string): string | null {
  if (address.length > 254 || !ADDRESS_PATTERN.test(address)) {
    return 'That does not look like an email address. Check it and try again.';
  }
  return null;
}

/** Domain parts that mean a Microsoft account, which needs a Microsoft sign-in this flow cannot do. */
const MICROSOFT_DOMAIN_PARTS: ReadonlySet<string> = new Set([
  'outlook',
  'hotmail',
  'live',
  'msn',
  'passport',
  'windowslive',
  'onmicrosoft',
]);

/** Mirrors the installer's outlook-family skip: any domain label naming a Microsoft service. */
export function isMicrosoftMailAddress(address: string): boolean {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  return domain.split('.').some(part => MICROSOFT_DOMAIN_PARTS.has(part));
}

/** The plain line for a Microsoft address; the same words the installer prints. */
export const MICROSOFT_MAIL_MESSAGE =
  'Microsoft addresses, such as Outlook, Hotmail, Live and MSN, need a Microsoft sign-in, which is coming later. Nothing was saved.';

/**
 * Why a typed server name cannot be used, in plain words, or null when it is a plain host name:
 * dot-separated labels of letters, digits and hyphens, no label starting or ending with a hyphen.
 * Mirrors the installer's host checks in email_other_problem.
 */
export function mailHostProblem(host: string): string | null {
  const problem = 'That server name does not look right. Check it and try again.';
  if (host === '' || host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host)) {
    return problem;
  }
  for (const label of host.split('.')) {
    if (label === '' || label.startsWith('-') || label.endsWith('-')) {
      return problem;
    }
  }
  return null;
}

/** Why a typed port cannot be used, in plain words, or null when it is a usable port number. */
export function mailPortProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'That port does not look right. Check it and try again.';
  }
  return null;
}
