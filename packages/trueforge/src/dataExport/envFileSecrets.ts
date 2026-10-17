import { SECRET_SETTING_NAMES, SECRET_URL_SETTING_NAMES, secretSettingValues, urlPassword } from '../secretSettings';

const SECRET_NAMES: ReadonlySet<string> = new Set([...SECRET_SETTING_NAMES, ...SECRET_URL_SETTING_NAMES]);
const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };

/** A value as docker compose reads it: quotes removed, escapes in double quotes applied, inline comments dropped. */
function settingValue(raw: string): string {
  const single = /^'([^']*)'/.exec(raw);
  if (single !== null) {
    return single[1] ?? '';
  }
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (double !== null) {
    return (double[1] ?? '').replace(/\\(.)/g, (_, char: string) => DOUBLE_QUOTE_ESCAPES[char] ?? char);
  }
  return raw.replace(/\s+#.*$/, '');
}

/**
 * Credential values from a dotenv file, so an export made from a copy of an old stack also blanks keys that lived
 * only in that stack's settings. Only the known secret settings count, plus a password inside any URL value.
 */
export function envFileSecretValues(text: string): string[] {
  const settings: Record<string, string> = {};
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const [, name = '', rawValue = ''] = match;
    const value = settingValue(rawValue.trim());
    if (SECRET_NAMES.has(name)) {
      settings[name] = value;
    } else {
      const password = urlPassword(value);
      if (password !== undefined) {
        values.push(password);
      }
    }
  }
  return [...secretSettingValues(settings), ...values];
}
