// Command line for `pnpm eval:tokens`. The token comes from the environment or a gitignored
// `.env.eval-tokens` file at the repo root, never from argv. Same order as the test mailbox scripts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEnvFile } from '../../demo/scripts/test-mailbox-env.mjs';
import { createInstanceClient } from './client.mjs';
import { loadTokenSet } from './parse.mjs';
import { DEFAULT_POLL_INTERVAL_MS, runEvalTokens } from './run.mjs';

export const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOKEN_KEY = 'TRUEFORGE_TOKEN';
const ENV_FILE_NAME = '.env.eval-tokens';
const DEFAULT_SET_PATH = ['packages', 'trueforge', 'evals', 'token-set.json'];
const DEFAULT_TEMPERATURE = 0;
const MAX_RUNS = 20;

export const USAGE = `Usage: pnpm eval:tokens -- --instance <url> --model <provider/model> --label <text> [options]

Required:
  --instance <url>      Address of your running TrueForge server, e.g. http://localhost:8790
  --model <id>          Model to test, as provider/model, e.g. anthropic/claude-sonnet-4-6
  --label <text>        Short name for this run, used in the output folder and the CSV

Options:
  --runs <n>            Times to run each prompt, 1 to ${String(MAX_RUNS)} (default 1)
  --temperature <n>     Sampling temperature, 0 to 2 (default ${String(DEFAULT_TEMPERATURE)})
  --set <file>          Prompt set file (default packages/trueforge/evals/token-set.json)
  --out <dir>           Output folder (default eval-results/<label>-<time>/)
  -h, --help            Show this help

Sign-in: if your server asks you to sign in, put TRUEFORGE_TOKEN=<your ID token> in a file
named .env.eval-tokens at the repo root, or set it as an environment variable. Never pass it on the command line.
`;

/** The runner only ever talks to an instance started with AMAN_EVAL_MODE=true, never to a person's own instance. */
export const NOT_EVAL_INSTANCE_MESSAGE =
  'This server is not an eval instance. Start a second Aman with AMAN_EVAL_MODE=true, and run the eval against that one.';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class UsageProblem extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UsageProblem';
  }
}

/**
 * pnpm passes a leading `--` through to the script, so it is dropped here.
 * @param {readonly string[]} argv
 */
export function parseRunnerArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        instance: { type: 'string' },
        model: { type: 'string' },
        label: { type: 'string' },
        runs: { type: 'string' },
        temperature: { type: 'string' },
        set: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageProblem(`${error.message}. Run with --help to see the options.`, { cause: error });
  }
  const { values } = parsed;
  if (values.help === true) {
    return { help: true };
  }
  if (values.instance === undefined) {
    throw new UsageProblem('Missing --instance. Give the address of your running server, e.g. http://localhost:8790.');
  }
  let instance;
  try {
    instance = new URL(values.instance);
  } catch (error) {
    throw new UsageProblem(`--instance must be a full web address, e.g. http://localhost:8790.`, { cause: error });
  }
  if (instance.protocol !== 'http:' && instance.protocol !== 'https:') {
    throw new UsageProblem('--instance must start with http:// or https://.');
  }
  if (values.model === undefined || !/^[^/\s]+\/\S+$/.test(values.model)) {
    throw new UsageProblem('Missing or wrong --model. Use provider/model, e.g. anthropic/claude-sonnet-4-6.');
  }
  if (values.label === undefined || values.label.trim() === '') {
    throw new UsageProblem('Missing --label. Give a short name for this run, e.g. --label baseline.');
  }
  const runs = values.runs === undefined ? 1 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new UsageProblem(`--runs must be a whole number from 1 to ${String(MAX_RUNS)}.`);
  }
  const temperature = values.temperature === undefined ? DEFAULT_TEMPERATURE : Number(values.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new UsageProblem('--temperature must be a number from 0 to 2.');
  }
  return {
    help: false,
    instance: instance.href.replace(/\/$/, ''),
    model: values.model,
    label: values.label.trim(),
    runs,
    temperature,
    setPath: values.set,
    outDir: values.out,
  };
}

/**
 * Reads TRUEFORGE_TOKEN from the environment first, then from the gitignored env file.
 * Returns undefined when neither is set. Values are never logged.
 */
export async function readRunnerToken({
  env = process.env,
  envFile = path.join(DEFAULT_ROOT_DIR, ENV_FILE_NAME),
} = {}) {
  const fromEnv = env[TOKEN_KEY];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  let text;
  try {
    text = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`Could not read ${ENV_FILE_NAME}. Check that the file is readable.`, { cause: error });
  }
  const value = parseEnvFile(text)[TOKEN_KEY];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Folder-safe label. The timestamp keeps colons out of the name so it works on every OS. */
export function defaultOutDir({ rootDir, label, now }) {
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  const stamp = now.toISOString().replace(/:/g, '-');
  return path.join(rootDir, 'eval-results', `${slug}-${stamp}`);
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
    args = parseRunnerArgs(argv);
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
    const tokenSet = await loadTokenSet(args.setPath ?? path.join(rootDir, ...DEFAULT_SET_PATH));
    const outDir = args.outDir ?? defaultOutDir({ rootDir, label: args.label, now });
    const result = await runEvalTokens({
      client,
      tokenSet,
      model: args.model,
      temperature: args.temperature,
      runs: args.runs,
      label: args.label,
      outDir,
      generatedAt: now,
      pollIntervalMs,
      log: message => stderr(`${message}\n`),
    });
    const counts = {};
    for (const row of result.rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    const statusLine = Object.entries(counts)
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(', ');
    stdout(`Wrote ${String(result.rows.length)} replies (${statusLine}).\n`);
    stdout(`CSV: ${result.csvPath}\nSummary: ${result.summaryPath}\n`);
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : 'The eval stopped for an unknown reason.'}\n`);
    return 1;
  }
}
