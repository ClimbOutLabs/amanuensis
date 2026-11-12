// Command line for `pnpm eval:spaces`. Same sign-in and eval-mode rules as `pnpm eval:tokens`.
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_ROOT_DIR,
  defaultOutDir,
  NOT_EVAL_INSTANCE_MESSAGE,
  parseRunnerArgs,
  readRunnerToken,
  UsageProblem,
} from '../eval-tokens/cli.mjs';
import { createInstanceClient } from '../eval-tokens/client.mjs';
import { DEFAULT_POLL_INTERVAL_MS } from '../eval-tokens/run.mjs';
import { loadSpaceSet } from './parse.mjs';
import { runEvalSpaces } from './run.mjs';

const ENV_FILE_NAME = '.env.eval-tokens';
const DEFAULT_SET_PATH = ['packages', 'trueforge', 'evals', 'space-set.json'];

export const USAGE = `Usage: pnpm eval:spaces -- --instance <url> --model <provider/model> --label <text> [options]

Required:
  --instance <url>      Address of your running TrueForge server in eval mode, e.g. http://localhost:8800
  --model <id>          Model to test, as provider/model
  --label <text>        Short name for this run, used in the output folder and the CSV

Options:
  --runs <n>            Times to run each prompt, 1 to 20 (default 1)
  --temperature <n>     Sampling temperature, 0 to 2 (default 0)
  --set <file>          Prompt set file (default packages/trueforge/evals/space-set.json)
  --out <dir>           Output folder (default eval-results/<label>-<time>/)
  --keep                Leave the spaces the model made in the instance, so you can open them
  -h, --help            Show this help

Sign-in: the same as pnpm eval:tokens. Put TRUEFORGE_TOKEN=<your ID token> in .env.eval-tokens at the repo root,
or set it as an environment variable. Never pass it on the command line.
`;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs the command. Returns the exit code: 0 ok, 1 failure, 2 usage.
 * @param {{
 *   argv: readonly string[],
 *   env?: Record<string, string | undefined>,
 *   stdout: (text: string) => void,
 *   stderr: (text: string) => void,
 *   now?: Date,
 *   rootDir?: string,
 *   fetchImpl?: typeof fetch,
 *   pollIntervalMs?: number,
 * }} options
 */
export async function main({
  argv,
  env = process.env,
  stdout,
  stderr,
  now = new Date(),
  rootDir = DEFAULT_ROOT_DIR,
  fetchImpl = fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  let args;
  try {
    args = parseRunnerArgs(argv, { allowKeep: true });
  } catch (error) {
    if (error instanceof UsageProblem) {
      stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    stdout(USAGE);
    return 0;
  }
  try {
    const token = await readRunnerToken({ env, envFile: path.join(rootDir, ENV_FILE_NAME) });
    if (token === undefined) {
      stderr('No sign-in token found. Continuing without one, which works only on a server with no sign-in.\n');
    }
    const client = createInstanceClient({ baseUrl: args.instance, token, fetchImpl });
    const health = await client.getHealth();
    if (!isRecord(health) || health.eval_mode !== true) {
      throw new Error(NOT_EVAL_INSTANCE_MESSAGE);
    }
    const spaceSet = await loadSpaceSet(args.setPath ?? path.join(rootDir, ...DEFAULT_SET_PATH));
    const result = await runEvalSpaces({
      client,
      spaceSet,
      model: args.model,
      temperature: args.temperature,
      runs: args.runs,
      label: args.label,
      outDir: args.outDir ?? defaultOutDir({ rootDir, label: args.label, now }),
      keep: args.keep,
      generatedAt: now,
      pollIntervalMs,
      log: message => stderr(`${message}\n`),
    });
    const met = result.rows.filter(row => row.expectations_met === true).length;
    stdout(`Wrote ${String(result.rows.length)} runs (${String(met)} met every target).\n`);
    stdout(`CSV: ${result.csvPath}\nSummary: ${result.summaryPath}\n`);
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : 'The eval stopped for an unknown reason.'}\n`);
    return 1;
  }
}
