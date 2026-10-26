/**
 * The calendar provider presets: the one table both the installer and the Settings Calendar card read.
 * The installer's copy lives in installer/lib/calendar.sh (CALENDAR_PRESETS); a test in this package parses
 * that table and fails if the two ever drift. Nothing here is stored; a preset only fills in the calendar
 * address for a provider the person picks. The rules for typed values mirror the installer's and are
 * worded for a person; the calendar sidecar applies the strict rules again before it saves anything.
 */
import { mailAddressProblem } from '../../email/mailConnector/presets';

export interface CaldavProviderPreset {
  /** Stable key, the same word the installer uses: fastmail, yahoo, gmx, webde, other. */
  key: string;
  /** The name the person sees in the picker. */
  name: string;
  /** One address for every account of the provider; null when it depends on the email domain or is typed. */
  server_url: string | null;
  /** Addresses that depend on the email domain (GMX); empty when `server_url` or a typed address is used. */
  domain_urls: readonly { domain: string; url: string }[];
  /**
   * The provider's own help page for making an app password, checked by hand when it was added.
   * Null when no official page could be checked, so the card shows the hint without a link.
   */
  help_url: string | null;
  /** One plain sentence on how to get an app password. */
  help_hint: string;
}

export const CALDAV_OTHER_PROVIDER_KEY = 'other';

export const CALDAV_PROVIDER_PRESETS: readonly CaldavProviderPreset[] = [
  {
    key: 'fastmail',
    name: 'Fastmail',
    server_url: 'https://caldav.fastmail.com/dav/',
    domain_urls: [],
    help_url: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
    help_hint:
      'Fastmail: make an app password under Settings, Privacy & Security, Manage app passwords, and allow calendar access.',
  },
  {
    key: 'yahoo',
    name: 'Yahoo',
    server_url: 'https://caldav.calendar.yahoo.com',
    domain_urls: [],
    help_url: 'https://help.yahoo.com/kb/SLN15241.html',
    help_hint: 'Yahoo: make an app password under Account Security, Generate app password.',
  },
  {
    key: 'gmx',
    name: 'GMX',
    server_url: null,
    domain_urls: [
      { domain: 'gmx.com', url: 'https://caldav.gmx.com/' },
      { domain: 'gmx.net', url: 'https://caldav.gmx.net/' },
    ],
    help_url: 'https://support.gmx.com/security/2fa/application-specific-passwords.html',
    help_hint:
      'GMX: turn on two-factor authentication, then make an application-specific password under Security Options.',
  },
  {
    key: 'webde',
    name: 'web.de',
    server_url: 'https://caldav.web.de',
    domain_urls: [],
    help_url: null,
    help_hint:
      'web.de: turn on two-factor authentication, then make an application-specific password under Security Options.',
  },
  {
    key: CALDAV_OTHER_PROVIDER_KEY,
    name: 'Other',
    server_url: null,
    domain_urls: [],
    help_url: null,
    help_hint: "Your calendar provider's help pages explain how to make an app password.",
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
  return preset.domain_urls.find(entry => entry.domain === domain)?.url ?? preset.server_url;
}

/**
 * The provider a saved calendar address belongs to: the preset that has this exact address, or 'other'.
 * The account file does not record the provider, so the address is the record.
 */
export function caldavProviderKeyForUrl(url: string): string {
  const match = CALDAV_PROVIDER_PRESETS.find(
    preset => preset.server_url === url || preset.domain_urls.some(entry => entry.url === url),
  );
  return match?.key ?? CALDAV_OTHER_PROVIDER_KEY;
}

/** Gmail addresses use the Google connector, not CalDAV. */
export function isGoogleMailAddress(email: string): boolean {
  const domain = emailDomain(email);
  return domain === 'gmail.com' || domain === 'googlemail.com';
}

export const GOOGLE_ADDRESS_MESSAGE =
  'Gmail addresses use the Google connector, not this card. Connect Google under Connectors instead. Nothing was saved.';

export function caldavGmxDomainMessage(email: string): string {
  return `GMX has no built-in calendar address for ${emailDomain(email)}. Choose Other and type the address from GMX's help page.`;
}

export const CALDAV_OTHER_NEEDS_ADDRESS_MESSAGE =
  'Type the calendar address from your provider, for example https://caldav.example.com/dav/.';

const MAX_VALUE_LENGTH = 512;
const URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/@%+=,:-]*)?$/;
const USER_PATTERN = /^[A-Za-z0-9._+@=-]+$/;
const PASSWORD_PATTERN = /^[A-Za-z0-9._+@=!%~,:/-]+$/;

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

/** Why an app password cannot be saved, in plain words, or null when it can. */
export function caldavPasswordProblem(password: string): string | null {
  if (password === '') {
    return 'The app password is needed. Create one at your provider, then type it here.';
  }
  if (password.length > MAX_VALUE_LENGTH || !PASSWORD_PATTERN.test(password)) {
    return 'The app password has a character that cannot be saved. Create a new app password with letters and numbers, then try again.';
  }
  return null;
}

/** Why the calendar account's email address cannot be used, in plain words, or null when it can. */
export function caldavEmailProblem(email: string): string | null {
  return mailAddressProblem(email);
}
