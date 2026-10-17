// Free of side effects, so a settings file can be read without loading the server configuration.

/** Settings whose whole value is a credential. */
export const SECRET_SETTING_NAMES = [
  'TRUEFORGE_API_KEY',
  'NEBIUS_API_KEY',
  'MEMORY_SCREEN_AUTH_TOKEN',
  'OIDC_CLIENT_SECRET',
  'TRUEFOUNDRY_API_KEY',
  'TRUEFOUNDRY_SANDBOX_API_KEY',
  'POSTGRES_PASSWORD',
] as const;

/** Connection URL settings: secret as a whole, and for the password inside. */
export const SECRET_URL_SETTING_NAMES = ['DATABASE_URL', 'REDIS_URL'] as const;

export type SecretSettingName = (typeof SECRET_SETTING_NAMES)[number] | (typeof SECRET_URL_SETTING_NAMES)[number];

/** The password a connection URL carries, decoded, or undefined when it has none or is not a URL. */
export function urlPassword(raw: string): string | undefined {
  try {
    const password = decodeURIComponent(new URL(raw).password);
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

/** The secret values among settings: each credential setting, and each connection URL with its password. */
export function secretSettingValues(settings: Partial<Record<SecretSettingName, string | undefined>>): string[] {
  const values: (string | undefined)[] = SECRET_SETTING_NAMES.map(name => settings[name]);
  for (const name of SECRET_URL_SETTING_NAMES) {
    const url = settings[name];
    values.push(url, url === undefined ? undefined : urlPassword(url));
  }
  return values.filter((value): value is string => value !== undefined && value !== '');
}
