import { urlPassword } from '../config';

/** Setting names whose values are credentials, as an old compose stack's .env spells them. */
const SECRET_SETTING_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

/**
 * Credential values from a dotenv file, so an export made from a copy of an old stack also blanks keys that lived
 * only in that stack's settings. Other values (addresses, flags) are left alone, apart from a password inside a URL.
 */
export function envFileSecretValues(text: string): string[] {
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const [, name = '', rawValue = ''] = match;
    const value = unquote(rawValue.trim());
    if (value === '') {
      continue;
    }
    if (SECRET_SETTING_NAME.test(name)) {
      values.push(value);
    }
    const password = urlPassword(value);
    if (password !== undefined) {
      values.push(password);
    }
  }
  return values;
}
