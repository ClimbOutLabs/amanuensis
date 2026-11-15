import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECRET_SETTING_NAMES } from '../../../src/config';

const CONFIG_SOURCE = readFileSync(resolve(__dirname, '..', '..', '..', 'src', 'config.ts'), 'utf8');

/** Every setting config.ts reads whose name says it holds a credential. */
function credentialSettingsRead(): string[] {
  const names = new Set<string>();
  for (const match of CONFIG_SOURCE.matchAll(/getEnv\('([A-Z0-9_]+)'/g)) {
    const name = match[1] ?? '';
    if (/_(SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)$/.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

describe('SECRET_SETTING_NAMES', () => {
  it('lists every credential setting the server reads, so exports and the outbound check cover each one', () => {
    const listed: ReadonlySet<string> = new Set(SECRET_SETTING_NAMES);
    const read = credentialSettingsRead();
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter(name => !listed.has(name))).toEqual([]);
  });

  it('covers the connector account secrets, the browser secret and the search key', () => {
    expect(SECRET_SETTING_NAMES).toEqual(
      expect.arrayContaining([
        'MAIL_EMAIL_ACCOUNT_SECRET',
        'CALENDAR_ACCOUNT_SECRET',
        'BROWSER_SECRET',
        'TAVILY_API_KEY',
      ]),
    );
  });
});
