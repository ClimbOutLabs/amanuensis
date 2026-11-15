import { secretsKeyFileFromEnv, sqlitePathFromEnv } from '../appDataDir';
import { processEnv, setProcessEnv, type CliEnv } from '../cli/env';
import { readKeyFile } from './fileKeyProvider';
import { keyRecordPath, readKeyRecord } from './keyRecordFile';
import { SAVED_ENV_SETTING, openSavedEnv, parseSavedEnv } from './savedEnv';

/**
 * The paid-account keys this instance keeps encrypted, in plain text. Nothing is returned when the
 * instance has none, keeps its records in Postgres, or this computer's key is not there or does
 * not open them: the start-up check that follows reports a missing or wrong key in its own words.
 */
export function savedEnvFor(env: CliEnv): Record<string, string> {
  if (env['STANDALONE'] === 'false') {
    return {};
  }
  try {
    const saved = parseSavedEnv(readKeyRecord({ file: keyRecordPath(sqlitePathFromEnv(env)), key: SAVED_ENV_SETTING }));
    if (Object.keys(saved).length === 0) {
      return {};
    }
    const loaded = readKeyFile(secretsKeyFileFromEnv(env));
    return loaded.status === 'loaded' ? openSavedEnv({ saved, key: loaded.key }) : {};
  } catch {
    return {};
  }
}

/**
 * Runs when this file is imported, which must be before the server config: the config reads the
 * environment once, as it loads. A value set in the environment itself wins over a saved one.
 */
const env = processEnv();
for (const [name, value] of Object.entries(savedEnvFor(env))) {
  const present = env[name];
  if (present === undefined || present === '') {
    setProcessEnv({ name, value });
  }
}
