/**
 * Fetches voice mode's listening model for host development (`pnpm dev`). Images already carry it.
 * The file is checked against the pinned size and hash before it is kept.
 */
import configuration from '../src/config';
import { downloadVadModel } from '../src/voice/vad/sileroVad';

const target = await downloadVadModel({ dir: configuration.VOICE_VAD_MODEL_DIR });
console.log(`Voice mode's listening model is ready at ${target}`);
