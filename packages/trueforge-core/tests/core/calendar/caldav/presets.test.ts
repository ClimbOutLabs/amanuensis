import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CALDAV_GOOGLE_PROVIDER_KEY,
  CALDAV_PROVIDER_PRESETS,
  caldavEmailProblem,
  caldavPasswordProblem,
  caldavPresetUrl,
  caldavProviderKeyForUrl,
  caldavProviderPreset,
  caldavUrlProblem,
  caldavUserProblem,
  GMAIL_NEEDS_GOOGLE_PROVIDER_MESSAGE,
  isGoogleMailAddress,
} from '../../../../src/core/calendar/caldav/presets';
import { EMAIL_PROVIDER_PRESETS } from '../../../../src/core/email/mailConnector/presets';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const CALENDAR_SH = resolve(REPO_ROOT, 'installer/lib/calendar.sh');

/** The installer's rows, parsed out of CALENDAR_PRESETS in installer/lib/calendar.sh. */
function installerPresetRows(): string[][] {
  const shell = readFileSync(CALENDAR_SH, 'utf8');
  const start = shell.indexOf("CALENDAR_PRESETS='");
  const end = shell.indexOf("'", start + "CALENDAR_PRESETS='".length);
  return shell
    .slice(start + "CALENDAR_PRESETS='".length, end)
    .split('\n')
    .map(line => line.trim().split(/\s+/));
}

/** The installer's Google setup step lines, in order, from calendar_google_steps in installer/lib/calendar.sh. */
function installerGoogleSteps(): string[] {
  const shell = readFileSync(CALENDAR_SH, 'utf8');
  const start = shell.indexOf('calendar_google_steps() {');
  const end = shell.indexOf('\n}', start);
  return shell
    .slice(start, end)
    .split('\n')
    .map(line => /^ui_line "(.*)"$/.exec(line.trim())?.[1])
    .filter((line): line is string => line !== undefined);
}

/** Runs one installer function with the given arguments and returns what it printed. */
function installerSays(fn: string, ...args: string[]): string {
  const done = spawnSync(
    'bash',
    [
      '-c',
      `. '${REPO_ROOT}/installer/lib/common.sh'; . '${REPO_ROOT}/installer/lib/shared.sh'; . '${CALENDAR_SH}'; ${fn} "$@"`,
      'installer',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return done.stdout.trim();
}

describe('calendar provider presets', () => {
  it('lists the providers in the card order, Google first and Other last', () => {
    expect(CALDAV_PROVIDER_PRESETS.map(preset => preset.key)).toEqual([
      'google',
      'fastmail',
      'yahoo',
      'gmx',
      'webde',
      'other',
    ]);
  });

  it('matches the installer preset table row for row', () => {
    const expected = CALDAV_PROVIDER_PRESETS.flatMap(preset => [
      ...(preset.server_url === null ? [] : [[preset.key, preset.server_url]]),
      ...preset.domain_urls.map(entry => [`${preset.key}:${entry.domain}`, entry.url]),
      ...(preset.account_url_template === null ? [] : [[preset.key, preset.account_url_template]]),
    ]);
    expect(installerPresetRows()).toEqual(expected);
  });

  it('gives the same address as the installer for every provider and domain', () => {
    const cases: [string, string][] = [
      ['google', 'person@gmail.com'],
      ['fastmail', 'owner@example.invalid'],
      ['yahoo', 'owner@example.invalid'],
      ['gmx', 'owner@gmx.com'],
      ['gmx', 'owner@GMX.NET'],
      ['gmx', 'owner@gmx.de'],
      ['webde', 'owner@web.de'],
      ['other', 'owner@example.invalid'],
    ];
    for (const [provider_key, email] of cases) {
      expect(caldavPresetUrl({ provider_key, email }) ?? '').toBe(
        installerSays('calendar_preset_url', provider_key, email),
      );
    }
    expect(caldavPresetUrl({ provider_key: 'nope', email: 'a@example.invalid' })).toBeNull();
  });

  it('works the provider out from a saved address', () => {
    expect(caldavProviderKeyForUrl('https://caldav.fastmail.com/dav/')).toBe('fastmail');
    expect(caldavProviderKeyForUrl('https://caldav.gmx.net/')).toBe('gmx');
    expect(caldavProviderKeyForUrl('https://calendar.google.com/calendar/dav/person@gmail.com/user/')).toBe('google');
    expect(caldavProviderKeyForUrl('https://calendar.google.com/calendar/')).toBe('other');
    expect(caldavProviderKeyForUrl('https://nas.example.invalid/dav/')).toBe('other');
  });

  it('gives every provider a help hint, and a help link only where one was checked', () => {
    for (const preset of CALDAV_PROVIDER_PRESETS) {
      expect(preset.help_hint.length).toBeGreaterThan(10);
      expect(preset.help_url === null || preset.help_url.startsWith('https://')).toBe(true);
    }
    expect(caldavProviderPreset('other')?.help_hint).toBe(
      "Your calendar provider's help pages explain how to make an app password.",
    );
    expect(caldavProviderPreset('other')?.help_url).toBeNull();
    expect(caldavProviderPreset('google')?.setup_steps).toHaveLength(4);
    expect(caldavProviderPreset('fastmail')?.setup_steps).toEqual([]);
  });

  it('uses the same app password help page as the email presets for the same provider', () => {
    for (const preset of CALDAV_PROVIDER_PRESETS) {
      const email = EMAIL_PROVIDER_PRESETS.find(item => item.key === preset.key);
      if (email !== undefined) {
        expect(preset.help_url).toBe(email.help_url);
      }
    }
  });

  it('builds the Google address from the email address', () => {
    const url = caldavPresetUrl({ provider_key: 'google', email: 'person@gmail.com' });
    expect(url).toBe('https://calendar.google.com/calendar/dav/person@gmail.com/user/');
    expect(url === null ? 'missing' : caldavUrlProblem(url)).toBeNull();
  });

  it('exports the Google provider key as one constant', () => {
    expect(CALDAV_GOOGLE_PROVIDER_KEY).toBe('google');
    expect(caldavProviderPreset(CALDAV_GOOGLE_PROVIDER_KEY)?.name).toBe('Google');
  });

  it('keeps the installer Google steps in sync with the preset setup steps', () => {
    expect(installerGoogleSteps()).toEqual([...(caldavProviderPreset(CALDAV_GOOGLE_PROVIDER_KEY)?.setup_steps ?? [])]);
    for (const step of caldavProviderPreset(CALDAV_GOOGLE_PROVIDER_KEY)?.setup_steps ?? []) {
      expect(step).not.toContain('below');
    }
  });

  it('encodes the email address into the Google address, the same way the installer does', () => {
    const email = "o'brien@gmail.com";
    const url = caldavPresetUrl({ provider_key: CALDAV_GOOGLE_PROVIDER_KEY, email });
    expect(url).toBe('https://calendar.google.com/calendar/dav/o%27brien@gmail.com/user/');
    expect(url === null ? 'missing' : caldavUrlProblem(url)).toBeNull();
    expect(url === null ? 'missing' : caldavProviderKeyForUrl(url)).toBe(CALDAV_GOOGLE_PROVIDER_KEY);
    expect(installerSays('calendar_preset_url', CALDAV_GOOGLE_PROVIDER_KEY, email)).toBe(url);
  });

  it('knows Gmail addresses need the Google provider', () => {
    expect(isGoogleMailAddress('person@gmail.com')).toBe(true);
    expect(isGoogleMailAddress('person@GoogleMail.com')).toBe(true);
    expect(isGoogleMailAddress('person@fastmail.com')).toBe(false);
    expect(GMAIL_NEEDS_GOOGLE_PROVIDER_MESSAGE).toBe(
      'Gmail calendars use the Google provider. Pick Google and try again. Nothing was saved.',
    );
  });
});

describe('calendar value rules', () => {
  const urls = [
    'https://caldav.fastmail.com/dav/',
    'https://nas.example.invalid:8443/dav/',
    'http://caldav.example.invalid/dav/',
    '',
    'https://me:secret@caldav.example.invalid/',
    'https://localhost/dav/',
    'https://calendar-caldav:9558/',
    'https://caldav.example.invalid/a b',
    'https://caldav.example.invalid/?q=1',
  ];
  const users = ['owner@example.invalid', '', 'a b', 'a;b'];
  const passwords = ['abcd-efgh-ijkl-mnop', '', 'has space', "it's"];

  it('agrees with the installer on what is acceptable', () => {
    for (const url of urls) {
      expect(caldavUrlProblem(url) === null).toBe(installerSays('calendar_url_problem', url) === '');
    }
    for (const user of users) {
      expect(caldavUserProblem(user) === null).toBe(installerSays('calendar_user_problem', user) === '');
    }
    for (const password of passwords) {
      expect(caldavPasswordProblem(password) === null).toBe(installerSays('calendar_secret_problem', password) === '');
    }
  });

  it('says in plain words what to do next', () => {
    expect(caldavUrlProblem('http://caldav.example.invalid/')).toContain('must start with https://');
    expect(caldavUrlProblem('https://me:secret@caldav.example.invalid/')).toContain('Remove the part before the @');
    expect(caldavUrlProblem('https://localhost/')).toContain('full server name');
    expect(caldavPasswordProblem('')).toContain('Create one at your provider');
    expect(caldavUserProblem('a b')).toContain('Use only letters');
    expect(caldavEmailProblem('not-an-address')).not.toBeNull();
    expect(caldavEmailProblem('owner@example.invalid')).toBeNull();
  });

  it('leaves the characters of a password to the calendar sidecar, which owns that rule', () => {
    for (const password of ['it\'s a "quoted" #1 = é', 'two words', '日本語']) {
      expect(caldavPasswordProblem(password)).toBeNull();
    }
    expect(caldavPasswordProblem('x'.repeat(513))).toContain('too long');
  });

  it('keeps the email address to printable ASCII, so the tool server is never given one it cannot use', () => {
    expect(caldavEmailProblem('a\u0001b@example.invalid')).toContain('character that cannot be saved');
    expect(caldavEmailProblem('owner@exämple.invalid')).toContain('character that cannot be saved');
    expect(caldavEmailProblem('first.last+tag@example.invalid')).toBeNull();
  });
});
