/**
 * Fetches voice mode's listening model for a source checkout (`pnpm dev` runs this first). Images already
 * carry it. The file is checked against the pinned size and hash before it is kept. With `--optional` a
 * failed download only prints a warning when no model is there yet, so starting the server offline works.
 *
 * Runs before the server config can load, so it reads the folder settings through the setup-script reader.
 */
import { voiceModelDirFromEnv } from '../src/appDataDir';
import { processEnv } from '../src/cli/env';
import { downloadVadModel } from './lib/vadModelDownload';

const optional = process.argv.includes('--optional');
try {
  const target = await downloadVadModel({ dir: voiceModelDirFromEnv(processEnv()) });
  console.log(`Voice mode's listening model is ready at ${target}`);
} catch (error) {
  const reason = error instanceof Error ? error.message : 'The download failed.';
  if (!optional) {
    throw new Error(reason, { cause: error });
  }
  console.warn(`${reason} Voice mode will not start until you are online and run \`pnpm voice:model\`.`);
}
