/**
 * Fetches voice mode's listening model for a source checkout (`pnpm dev` runs this first). Images already
 * carry it. The file is checked against the pinned size and hash before it is kept. With `--optional` a
 * failed download only prints a warning when no model is there yet, so starting the server offline works.
 *
 * Runs before anything is built, so it must not import the server config; it reads the same two folder
 * settings directly.
 */
import { defaultVoiceModelDir, resolveAppDataDir } from '../src/appDataDir';
import { downloadVadModel } from '../src/voice/vad/sileroVad';

const optional = process.argv.includes('--optional');
const { VOICE_VAD_MODEL_DIR, APP_DATA_DIR, APP_DATA_DIR_SUFFIX } = process.env;
const dir =
  VOICE_VAD_MODEL_DIR ??
  defaultVoiceModelDir(resolveAppDataDir({ override: APP_DATA_DIR, suffix: APP_DATA_DIR_SUFFIX ?? '' }));
try {
  const target = await downloadVadModel({ dir });
  console.log(`Voice mode's listening model is ready at ${target}`);
} catch (error) {
  const reason = error instanceof Error ? error.message : 'The download failed.';
  if (!optional) {
    throw new Error(reason, { cause: error });
  }
  console.warn(`${reason} Voice mode will not start until you are online and run \`pnpm voice:model\`.`);
}
