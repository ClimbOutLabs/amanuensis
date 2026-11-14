import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { EmbeddingModel } from '../../../src/runtime/memory/embeddingModel';
import { RECORD_COMMAND, RecordedTextsSchema, recordVectors } from './recordedVectors';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  // pnpm hands a bare `--` through when a script is run with extra arguments.
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: { texts: { type: 'string' }, 'model-dir': { type: 'string' } },
  });
  const textsFile = values.texts;
  const modelDir = values['model-dir'];
  if (textsFile === undefined) {
    fail(`The --texts file is missing. The command lists it for you; run the whole command: ${RECORD_COMMAND}`);
  }
  if (modelDir === undefined) {
    fail(
      `The --model-dir folder is missing. Name the folder that holds the downloaded search model: ${RECORD_COMMAND}`,
    );
  }

  const texts = RecordedTextsSchema.parse(JSON.parse(await readFile(textsFile, 'utf8')));
  const model = new EmbeddingModel({ modelDir });
  if (!(await model.ensureReady())) {
    fail(
      `The search model did not load: ${model.failureReason}\nCheck that the folder ${modelDir} holds the downloaded model, then run the command again.`,
    );
  }
  const dir = path.join(import.meta.dirname, 'recordedVectors');
  const count = await recordVectors({ texts, model, dir });
  console.log(`Recorded ${String(count)} vectors in ${dir}. Commit the two files.`);
}

await main();
