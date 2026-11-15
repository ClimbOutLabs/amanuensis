import path from 'node:path';

import envPaths from 'env-paths';

import type { CliEnv } from './cli/env';

const ENV_PATHS_APP_NAME = 'trueforge';

/**
 * Where the app keeps its data. An explicit directory wins; otherwise the OS-standard data folder is used.
 */
export function resolveAppDataDir({ override, suffix }: { override: string | undefined; suffix: string }): string {
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return envPaths(ENV_PATHS_APP_NAME, { suffix }).data;
}

/** The data folder an environment names (`APP_DATA_DIR`, `APP_DATA_DIR_SUFFIX`); the one place those settings are read. */
export function appDataDirFromEnv(env: CliEnv): string {
  return resolveAppDataDir({ override: env['APP_DATA_DIR'], suffix: env['APP_DATA_DIR_SUFFIX'] ?? '' });
}

/**
 * Where voice mode's listening model lives: `VOICE_VAD_MODEL_DIR` when set, else a folder in the data folder.
 * The server config and the setup script both call this, with free imports, so neither can drift from the other.
 */
export function voiceModelDirFromEnv(env: CliEnv): string {
  const set = env['VOICE_VAD_MODEL_DIR'];
  return set !== undefined && set.trim() !== '' ? path.resolve(set) : path.join(appDataDirFromEnv(env), 'voice-model');
}

function pathFromEnv({ env, name, fallback }: { env: CliEnv; name: string; fallback: string[] }): string {
  const set = env[name];
  return set !== undefined && set.trim() !== '' ? path.resolve(set) : path.join(appDataDirFromEnv(env), ...fallback);
}

/** The SQLite file of standalone mode: `SQLITE_PATH` when set, else `db/db.sqlite` in the data folder. */
export function sqlitePathFromEnv(env: CliEnv): string {
  return pathFromEnv({ env, name: 'SQLITE_PATH', fallback: ['db', 'db.sqlite'] });
}

/**
 * Where the host puts the master key for saved secrets: `SECRETS_KEY_FILE` when set (the installer points it at
 * the file its startup job fills), else `secrets/master.key` in the data folder.
 */
export function secretsKeyFileFromEnv(env: CliEnv): string {
  return pathFromEnv({ env, name: 'SECRETS_KEY_FILE', fallback: ['secrets', 'master.key'] });
}
