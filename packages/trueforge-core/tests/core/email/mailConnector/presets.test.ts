import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanMailPassword,
  EMAIL_PROVIDER_PRESETS,
  emailProviderPreset,
  type EmailProviderPreset,
  isMicrosoftMailAddress,
  mailAddressProblem,
  mailHostProblem,
  mailModeForCustomPort,
  mailPasswordProblem,
  mailPortProblem,
  mailProviderKeyForHosts,
} from '../../../../src/core/email/mailConnector/presets';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

/** The installer's preset rows, parsed out of EMAIL_PRESETS in installer/lib/email.sh. */
function installerPresetRows(): string[][] {
  const shell = readFileSync(resolve(REPO_ROOT, 'installer/lib/email.sh'), 'utf8');
  const start = shell.indexOf("EMAIL_PRESETS='");
  const end = shell.indexOf("'", start + "EMAIL_PRESETS='".length);
  return shell
    .slice(start + "EMAIL_PRESETS='".length, end)
    .split('\n')
    .map(line => line.trim().split(/\s+/));
}

describe('email provider presets', () => {
  it('lists the providers in the card order, Gmail first and web.de last', () => {
    expect(EMAIL_PROVIDER_PRESETS.map(preset => preset.key)).toEqual([
      'gmail',
      'yahoo',
      'aol',
      'icloud',
      'fastmail',
      'zoho',
      'gmx',
      'webde',
    ]);
  });

  it('matches the installer preset table row for row', () => {
    const rows = installerPresetRows();
    expect(rows).toHaveLength(EMAIL_PROVIDER_PRESETS.length);
    for (const [index, preset] of EMAIL_PROVIDER_PRESETS.entries()) {
      const row = rows[index];
      expect(row).toEqual([
        preset.key,
        preset.imap_host,
        String(preset.imap_port),
        preset.imap_mode,
        preset.smtp_host,
        String(preset.smtp_port),
        preset.smtp_mode,
        preset.app_password_spaces_stripped ? 'strip-spaces' : 'keep-spaces',
      ]);
    }
  });

  it('finds a preset by key and nothing for an unknown key', () => {
    expect(emailProviderPreset('gmail')?.imap_host).toBe('imap.gmail.com');
    expect(emailProviderPreset('gmail')?.smtp_host).toBe('smtp.gmail.com');
    expect(emailProviderPreset('nope')).toBeUndefined();
  });

  it('derives a custom server mode from its port, like the installer', () => {
    expect(mailModeForCustomPort('imap', 993)).toBe('ssl');
    expect(mailModeForCustomPort('imap', 143)).toBe('starttls');
    expect(mailModeForCustomPort('smtp', 465)).toBe('ssl');
    expect(mailModeForCustomPort('smtp', 587)).toBe('starttls');
  });

  it('strips display spaces exactly when the provider preset record says it groups them', () => {
    for (const preset of EMAIL_PROVIDER_PRESETS) {
      expect(cleanMailPassword({ preset, password: 'ab cd ef' })).toBe(
        preset.app_password_spaces_stripped ? 'abcdef' : 'ab cd ef',
      );
    }
    expect(cleanMailPassword({ preset: undefined, password: 'ab cd ef' })).toBe('ab cd ef');
  });

  it('strips display spaces for an invented provider whose record carries the flag, and keeps them without it', () => {
    const invented: EmailProviderPreset = {
      key: 'northmail',
      name: 'Northmail',
      imap_host: 'imap.northmail.example',
      imap_port: 993,
      imap_mode: 'ssl',
      smtp_host: 'smtp.northmail.example',
      smtp_port: 465,
      smtp_mode: 'ssl',
      app_password_spaces_stripped: true,
      help_url: null,
      help_hint: 'Northmail: make an app password under Security.',
    };
    expect(cleanMailPassword({ preset: invented, password: 'ab cd ef' })).toBe('abcdef');
    expect(
      cleanMailPassword({ preset: { ...invented, app_password_spaces_stripped: false }, password: 'ab cd ef' }),
    ).toBe('ab cd ef');
  });

  it('the installer cleans a password by the flag on the row, for an invented provider too', () => {
    const script = [
      'source "$1"',
      'EMAIL_PRESETS="northmail imap.northmail.example 993 ssl smtp.northmail.example 465 ssl strip-spaces',
      'plainmail imap.plainmail.example 993 ssl smtp.plainmail.example 465 ssl keep-spaces"',
      'email_clean_password northmail "ab cd ef"; echo',
      'email_clean_password plainmail "ab cd ef"; echo',
      'email_clean_password gmail "ab cd ef"; echo',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script, 'test', resolve(REPO_ROOT, 'installer/lib/email.sh')], {
      encoding: 'utf8',
    });
    // The invented strip-spaces row strips, the keep-spaces row keeps, and gmail keeps its
    // spaces here because the replaced table has no gmail row at all.
    expect(out.split('\n').slice(0, 3)).toEqual(['abcdef', 'ab cd ef', 'ab cd ef']);
  });

  it('refuses passwords the account file cannot hold, in plain words', () => {
    expect(mailPasswordProblem('')).toBe('The app password was empty, so nothing was saved.');
    expect(mailPasswordProblem('abc\u0007def')).toContain('cannot be saved');
    expect(mailPasswordProblem("ab'cd")).toContain('cannot be saved');
    expect(mailPasswordProblem('abcd efgh')).toBeNull();
  });

  it('checks addresses and Microsoft domains like the installer', () => {
    expect(mailAddressProblem('person@example.com')).toBeNull();
    expect(mailAddressProblem('not-an-address')).not.toBeNull();
    expect(mailAddressProblem('a@b')).not.toBeNull();
    expect(isMicrosoftMailAddress('person@outlook.com')).toBe(true);
    expect(isMicrosoftMailAddress('person@hotmail.co.uk')).toBe(true);
    expect(isMicrosoftMailAddress('person@contoso.onmicrosoft.com')).toBe(true);
    expect(isMicrosoftMailAddress('person@gmail.com')).toBe(false);
  });

  it('checks typed server names and ports', () => {
    expect(mailHostProblem('imap.example.com')).toBeNull();
    expect(mailHostProblem('-bad.example.com')).not.toBeNull();
    expect(mailHostProblem('bad..example.com')).not.toBeNull();
    expect(mailHostProblem('bad host')).not.toBeNull();
    expect(mailPortProblem(993)).toBeNull();
    expect(mailPortProblem(0)).not.toBeNull();
    expect(mailPortProblem(65536)).not.toBeNull();
    expect(mailPortProblem(1.5)).not.toBeNull();
  });

  it('works the provider out from a saved account servers', () => {
    expect(mailProviderKeyForHosts({ imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com' })).toBe('gmail');
    expect(mailProviderKeyForHosts({ imap_host: 'imap.web.de', smtp_host: 'smtp.web.de' })).toBe('webde');
    expect(mailProviderKeyForHosts({ imap_host: 'mail.example.com', smtp_host: 'mail.example.com' })).toBe('other');
  });

  it('gives every provider a help hint, and a checked help link for all but web.de', () => {
    for (const preset of EMAIL_PROVIDER_PRESETS) {
      expect(preset.help_hint.length).toBeGreaterThan(10);
      if (preset.key === 'webde') {
        // web.de's help pages could not be reached to check, so no link is offered rather than a guessed one.
        expect(preset.help_url).toBeNull();
      } else {
        expect(preset.help_url).toMatch(/^https:\/\//);
      }
    }
  });
});
