/**
 * The calendar provider presets: the one table both the installer and the Settings Calendar card read.
 * The installer's copy lives in installer/lib/calendar.sh (CALENDAR_PRESETS); a test in this package parses
 * that table and fails if the two ever drift. Nothing here is stored; a preset only fills in the calendar
 * address for a provider the person picks, from a fixed address, the email domain or the email address
 * itself. The rules for typed values mirror the installer's and are worded for a person; the calendar
 * sidecar applies the strict rules again before it saves anything.
 */
import { mailAddressProblem } from '../../email/mailConnector/presets';

export interface CaldavProviderPreset {
  /** Stable key, the same word the installer uses: google, fastmail, yahoo, gmx, webde, other. */
  key: string;
  /** The name the person sees in the picker. */
  name: string;
  /**
   * One address for every account of the provider; null when it depends on the email domain, the email
   * address itself or is typed.
   */
  server_url: string | null;
  /** Addresses that depend on the email domain (GMX); empty when `server_url` or a typed address is used. */
  domain_urls: readonly { domain: string; url: string }[];
  /** An address made from the email address, with `{email}` where the address goes; null for other providers. */
  account_url_template: string | null;
  /**
   * The provider's own help page for making an app password, checked by hand when it was added.
   * Null when no official page could be checked, so the card shows the hint without a link.
   */
  help_url: string | null;
  /** One plain sentence on how to get an app password. */
  help_hint: string;
  /** Plain steps to show before the form, when the provider needs more than the one-line hint. */
  setup_steps: readonly string[];
}

export const CALDAV_OTHER_PROVIDER_KEY = 'other';

export const CALDAV_PROVIDER_PRESETS: readonly CaldavProviderPreset[] = [
  {
    key: 'google',
    name: 'Google',
    server_url: null,
    domain_urls: [],
    account_url_template: 'https://calendar.google.com/calendar/dav/{email}/user/',
    help_url: 'https://support.google.com/accounts/answer/185833',
    help_hint: 'Google: turn on 2-Step Verification, then make an app password at myaccount.google.com/apppasswords.',
    setup_steps: [
      'Turn on 2-Step Verification for your Google account, if it is not on yet. Google only offers app passwords after that.',
      'Open myaccount.google.com/apppasswords, type a name such as Aman, and select Create.',
      'Copy the 16-letter password Google shows. Google shows it only once.',
      'Pick Google below, type your Gmail address, and paste the app password. Leave the login name empty.',
    ],
  },
  {
    key: 'fastmail',
    name: 'Fastmail',
    server_url: 'https://caldav.fastmail.com/dav/',
    domain_urls: [],
    account_url_template: null,
    help_url: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
    help_hint:
      'Fastmail: make an app password under Settings, Privacy & Security, Manage app passwords, and allow calendar access.',
    setup_steps: [],
  },
  {
    key: 'yahoo',
    name: 'Yahoo',
    server_url: 'https://caldav.calendar.yahoo.com',
    domain_urls: [],
    account_url_template: null,
    help_url: 'https://help.yahoo.com/kb/SLN15241.html',
    help_hint: 'Yahoo: make an app password under Account Security, Generate app password.',
    setup_steps: [],
  },
  {
    key: 'gmx',
    name: 'GMX',
    server_url: null,
    domain_urls: [
      { domain: 'gmx.com', url: 'https://caldav.gmx.com/' },
      { domain: 'gmx.net', url: 'https://caldav.gmx.net/' },
    ],
    account_url_template: null,
    help_url: 'https://support.gmx.com/security/2fa/application-specific-passwords.html',
    help_hint:
      'GMX: turn on two-factor authentication, then make an application-specific password under Security Options.',
    setup_steps: [],
  },
  {
    key: 'webde',
    name: 'web.de',
    server_url: 'https://caldav.web.de',
    domain_urls: [],
    account_url_template: null,
    help_url: null,
    help_hint:
      'web.de: turn on two-factor authentication, then make an application-specific password under Security Options.',
    setup_steps: [],
  },
  {
    key: CALDAV_OTHER_PROVIDER_KEY,
    name: 'Other',
    server_url: null,
    domain_urls: [],
    account_url_template: null,
    help_url: null,
    help_hint: "Your calendar provider's help pages explain how to make an app password.",
    setup_steps: [],
  },
];

/** The preset for a key, or undefined when the key names no known provider. */
export function caldavProviderPreset(key: string): CaldavProviderPreset | undefined {
  return CALDAV_PROVIDER_PRESETS.find(preset => preset.key === key);
}

function emailDomain(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

/** The built-in calendar address for a provider and account, or null when the address has to be typed. */
export function caldavPresetUrl(input: { provider_key: string; email: string }): string | null {
  const preset = caldavProviderPreset(input.provider_key);
  if (preset === undefined) {
    return null;
  }
  const domain = emailDomain(input.email);
  return (
    preset.domain_urls.find(entry => entry.domain === domain)?.url ??
    preset.server_url ??
    (preset.account_url_template === null ? null : preset.account_url_template.split('{email}').join(input.email))
  );
}

function matchesAccountUrlTemplate(url: string, template: string): boolean {
  const marker = '{email}';
  const markerIndex = template.indexOf(marker);
  if (markerIndex === -1) {
    return false;
  }
  const before = template.slice(0, markerIndex);
  const after = template.slice(markerIndex + marker.length);
  if (!url.startsWith(before) || !url.endsWith(after) || url.length <= before.length + after.length) {
    return false;
  }
  const account = url.slice(before.length, url.length - after.length);
  return account !== '' && !account.includes('/');
}

/**
 * The provider a saved calendar address belongs to: the preset that has this exact address, or one whose
 * email-based address matches it, or 'other'. The account file does not record the provider, so the
 * address is the record.
 */
export function caldavProviderKeyForUrl(url: string): string {
  const match = CALDAV_PROVIDER_PRESETS.find(
    preset =>
      preset.server_url === url ||
      preset.domain_urls.some(entry => entry.url === url) ||
      (preset.account_url_template !== null && matchesAccountUrlTemplate(url, preset.account_url_template)),
  );
  return match?.key ?? CALDAV_OTHER_PROVIDER_KEY;
}

/** Whether the email address belongs to Gmail or Googlemail. */
export function isGoogleMailAddress(email: string): boolean {
  const domain = emailDomain(email);
  return domain === 'gmail.com' || domain === 'googlemail.com';
}

export const GMAIL_NEEDS_GOOGLE_PROVIDER_MESSAGE =
  'Gmail calendars use the Google provider. Pick Google and try again. Nothing was saved.';

export function caldavGmxDomainMessage(email: string): string {
  return `GMX has no built-in calendar address for ${emailDomain(email)}. Choose Other and type the address from GMX's help page.`;
}

export const CALDAV_OTHER_NEEDS_ADDRESS_MESSAGE =
  'Type the calendar address from your provider, for example https://caldav.example.com/dav/.';

const MAX_VALUE_LENGTH = 512;
const URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/@%+=,:-]*)?$/;
const USER_PATTERN = /^[A-Za-z0-9._+@=-]+$/;
// Printable ASCII only, so a header or a search built from the address cannot be broken.
const EMAIL_PATTERN = /^[\x21-\x7E]+$/;

/**
 * Why a typed calendar address cannot be used, in plain words, or null when its shape is fine. The address
 * must be https, hold no name or password, and have a full server name. Which servers may be reached is
 * decided by the calendar sidecar, which checks the address it actually connects to.
 */
export function caldavUrlProblem(url: string): string | null {
  if (url === '') {
    return 'A calendar address is needed. Type the full address, for example https://caldav.fastmail.com/dav/.';
  }
  if (!url.startsWith('https://')) {
    return 'The calendar address must start with https://. Type the full address, for example https://caldav.fastmail.com/dav/.';
  }
  const host = url.slice('https://'.length).split('/')[0] ?? '';
  if (host.includes('@')) {
    return 'The calendar address must not hold a name or password. Remove the part before the @, then type it again.';
  }
  if (url.length > MAX_VALUE_LENGTH || !URL_PATTERN.test(url)) {
    return "The calendar address has a character that is not allowed. Copy the address from your provider's help page.";
  }
  if (!(host.split(':')[0] ?? '').includes('.')) {
    return "The calendar address needs a full server name with dots, such as caldav.example.com. Copy the address from your provider's help page.";
  }
  return null;
}

/** Why a login name cannot be saved, in plain words, or null when it can. */
export function caldavUserProblem(user: string): string | null {
  if (user === '') {
    return 'A login name is needed. Type the email address you sign in to the calendar with.';
  }
  if (user.length > MAX_VALUE_LENGTH || !USER_PATTERN.test(user)) {
    return 'The login name has a character that cannot be saved. Use only letters, numbers and . _ + @ = -.';
  }
  return null;
}

/**
 * Why an app password cannot be saved, in plain words, or null when it can. Which characters it may hold is
 * decided in one place, the calendar sidecar, which refuses a bad one with the field's name.
 */
export function caldavPasswordProblem(password: string): string | null {
  if (password === '') {
    return 'The app password is needed. Create one at your provider, then type it here.';
  }
  if (password.length > MAX_VALUE_LENGTH) {
    return 'The app password is too long to save. Create a shorter app password, then try again.';
  }
  return null;
}

/** Why the calendar account's email address cannot be used, in plain words, or null when it can. */
export function caldavEmailProblem(email: string): string | null {
  const problem = mailAddressProblem(email);
  if (problem !== null) {
    return problem;
  }
  if (!EMAIL_PATTERN.test(email)) {
    return 'The email address has a character that cannot be saved. Use plain letters and numbers, then try again.';
  }
  return null;
}
