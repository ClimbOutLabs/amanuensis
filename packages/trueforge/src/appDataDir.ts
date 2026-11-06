import path from 'node:path';

import envPaths from 'env-paths';

const ENV_PATHS_APP_NAME = 'trueforge';

/**
 * Where the app keeps its data. An explicit directory wins; otherwise the OS-standard data folder is used.
 * Kept free of other imports so setup scripts can find the folder before anything is built.
 */
export function resolveAppDataDir({ override, suffix }: { override: string | undefined; suffix: string }): string {
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return envPaths(ENV_PATHS_APP_NAME, { suffix }).data;
}

/** Default folder for voice mode's listening model; `VOICE_VAD_MODEL_DIR` overrides it. */
export function defaultVoiceModelDir(appDataDir: string): string {
  return path.join(appDataDir, 'voice-model');
}
