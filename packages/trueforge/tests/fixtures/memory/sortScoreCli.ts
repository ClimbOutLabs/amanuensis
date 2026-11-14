import { execFileRunner } from '@truefoundry/trueforge-core/core';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createLogger } from 'winston';
import { z } from 'zod';

import { sortNote, type SortModel } from '../../../src/runtime/memory/pageSorter';
import { MAYA_ENTRIES } from './mayaWorld/entries';
import { describeScore, MAYA_STORY_ENTRIES, scoreSorter } from './mayaWorld/sortScore';

const COMMAND =
  'pnpm --filter @truefoundry/trueforge memory:sort-score -- --base-url <url> --model <name> [--api-key-env <NAME>] [--out <file>] [--all]';

/** The same cap on the reply that the product asks for. */
const MAX_TOKENS = 1600;
const CALL_TIMEOUT_MS = 120_000;
const ERROR_BODY_CHARACTERS = 200;

const ChatReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A model behind an OpenAI-compatible endpoint. The key goes in a header and is never printed. */
function endpointModel({
  baseUrl,
  model,
  apiKey,
}: {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}): SortModel {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async messages => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0 }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, ERROR_BODY_CHARACTERS);
        return { ok: false, reason: `the endpoint answered ${String(response.status)}: ${body}` };
      }
      const parsed = ChatReplySchema.safeParse(await response.json());
      const content = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
      return content === undefined || content === null || content.trim() === ''
        ? { ok: false, reason: 'the endpoint sent no reply text' }
        : { ok: true, reply: content };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

async function main(): Promise<void> {
  // pnpm hands a bare `--` through when a script is run with extra arguments.
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'api-key-env': { type: 'string' },
      out: { type: 'string' },
      all: { type: 'boolean' },
    },
  });
  const baseUrl = values['base-url'];
  const model = values.model;
  if (baseUrl === undefined || model === undefined) {
    fail(`The --base-url and --model are needed. Run the whole command: ${COMMAND}`);
  }
  const keyName = values['api-key-env'];
  const apiKey = keyName === undefined ? undefined : process.env[keyName];
  if (keyName !== undefined && (apiKey === undefined || apiKey === '')) {
    fail(`The environment variable ${keyName} is empty. Set it to the key for the model, then run the command again.`);
  }

  const askModel = endpointModel({ baseUrl, model, apiKey });
  const logger = createLogger({ silent: true });
  const entries = values.all === true ? MAYA_ENTRIES : MAYA_STORY_ENTRIES;
  let done = 0;
  const score = await scoreSorter({
    entries,
    sorter: async ({ vaultDir, note }) => {
      const result = await sortNote({
        mode: 'report',
        note,
        askModel,
        options: { vaultDir, runner: execFileRunner, today: note.day, logger },
      });
      done += 1;
      if (done % 10 === 0) {
        console.error(`Sorted ${String(done)} of ${String(entries.length)} notes.`);
      }
      return result;
    },
  });

  console.log(describeScore(score));
  if (values.out !== undefined) {
    await writeFile(values.out, `${JSON.stringify(score.misses, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${String(score.misses.length)} misses to ${values.out}.`);
  }
}

await main();
