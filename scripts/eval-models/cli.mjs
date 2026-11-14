// Command line for `pnpm eval:models`. The sign-in token comes from the environment or the gitignored
// `.env.eval-tokens` file, never from argv. Model keys stay in the eval instance.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_ROOT_DIR,
  defaultOutDir,
  NOT_EVAL_INSTANCE_MESSAGE,
  readRunnerToken,
  UsageProblem,
} from '../eval-tokens/cli.mjs';
import { createInstanceClient } from '../eval-tokens/client.mjs';
import { loadTokenSet } from '../eval-tokens/parse.mjs';
import { DEFAULT_POLL_INTERVAL_MS } from '../eval-tokens/run.mjs';
import { loadSpaceFixture } from '../eval-tokens/space.mjs';
import { loadModelSet } from './parse.mjs';
import { emptyHistory, findDrops, historyMarkdown, parseHistory } from './report.mjs';
import { runEvalModels } from './run.mjs';

const EVALS_DIR = ['packages', 'trueforge', 'evals'];
const MAX_RUNS = 5;
const MAX_MODELS = 8;
const DEFAULT_MAX_DROP_POINTS = 10;
/** Exit code when the run finished but a model scored worse than its last run. */
export const DROP_EXIT_CODE = 3;

export const USAGE = `Usage: pnpm eval:models -- --instance <url> --models <a,b,...> --label <text> [options]

Required:
  --instance <url>       Address of an Aman started with AMAN_EVAL_MODE=true, e.g. http://localhost:8800
  --models <list>        One or more models to compare, comma separated, as provider/model
  --label <text>         Short name for this run, used in the output folder

Options:
  --judge <model>        Model that grades checklist items, as provider/model (default: the first model)
  --runs <n>             Times to run each case, 1 to ${String(MAX_RUNS)} (default 1)
  --temperature <n>      Sampling temperature, 0 to 2 (default 0)
  --prices <file>        JSON prices per model, in US dollars per million tokens, e.g.
                         {"spark/deepseek": {"input_per_million": 0, "output_per_million": 0}}
                         Token Factory models are priced by the instance without this.
  --history <file>       Score history file to compare against and add this run to
  --max-drop <points>    Fail when a model's pass rate falls by more than this many points (default ${String(DEFAULT_MAX_DROP_POINTS)})
  --out <dir>            Output folder (default eval-results/<label>-<time>/)
  -h, --help             Show this help

Sign-in: put TRUEFORGE_TOKEN=<token> in .env.eval-tokens at the repo root, or set it in the environment.
`;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MODEL_NAME = /^[^/\s,]+\/\S+$/;

/** @param {readonly string[]} argv */
export function parseModelArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        instance: { type: 'string' },
        models: { type: 'string' },
        label: { type: 'string' },
        judge: { type: 'string' },
        runs: { type: 'string' },
        temperature: { type: 'string' },
        prices: { type: 'string' },
        history: { type: 'string' },
        'max-drop': { type: 'string' },
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
  let instance;
  try {
    instance = new URL(values.instance ?? '');
  } catch (error) {
    throw new UsageProblem('Missing or wrong --instance. Give a full address, e.g. http://localhost:8800.', {
      cause: error,
    });
  }
  if (instance.protocol !== 'http:' && instance.protocol !== 'https:') {
    throw new UsageProblem('--instance must start with http:// or https://.');
  }
  const models = [
    ...new Set(
      (values.models ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== ''),
    ),
  ];
  if (models.length === 0 || models.length > MAX_MODELS || !models.every(name => MODEL_NAME.test(name))) {
    throw new UsageProblem(
      `Missing or wrong --models. Give 1 to ${String(MAX_MODELS)} models as provider/model, separated by commas.`,
    );
  }
  const judge = values.judge?.trim() || models[0];
  if (!MODEL_NAME.test(judge)) {
    throw new UsageProblem('Wrong --judge. Give one model as provider/model.');
  }
  if (values.label === undefined || values.label.trim() === '') {
    throw new UsageProblem('Missing --label. Give a short name for this run, e.g. --label weekly.');
  }
  const runs = values.runs === undefined ? 1 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new UsageProblem(`--runs must be a whole number from 1 to ${String(MAX_RUNS)}.`);
  }
  const temperature = values.temperature === undefined ? 0 : Number(values.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new UsageProblem('--temperature must be a number from 0 to 2.');
  }
  const maxDrop = values['max-drop'] === undefined ? DEFAULT_MAX_DROP_POINTS : Number(values['max-drop']);
  if (!Number.isFinite(maxDrop) || maxDrop < 0 || maxDrop > 100) {
    throw new UsageProblem('--max-drop must be a number of points from 0 to 100.');
  }
  return {
    help: false,
    instance: instance.href.replace(/\/$/, ''),
    models,
    judge,
    label: values.label.trim(),
    runs,
    temperature,
    pricesPath: values.prices,
    historyPath: values.history,
    maxDrop,
    outDir: values.out,
  };
}

/** Reads the optional prices file. Each entry needs both prices as numbers of zero or more. */
export async function loadPrices(file) {
  if (file === undefined) {
    return {};
  }
  let json;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the prices at ${file}. Check that the file exists and is valid JSON.`, {
      cause: error,
    });
  }
  const valid =
    isRecord(json) &&
    Object.values(json).every(
      price =>
        isRecord(price) &&
        typeof price.input_per_million === 'number' &&
        price.input_per_million >= 0 &&
        typeof price.output_per_million === 'number' &&
        price.output_per_million >= 0,
    );
  if (!valid) {
    throw new Error(
      `The prices at ${file} are not in the right shape. Use {"provider/model": {"input_per_million": 0.3, "output_per_million": 0.9}}.`,
    );
  }
  return json;
}

async function readHistory(file) {
  try {
    return parseHistory(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptyHistory();
    }
    throw new Error(`Could not read the score history at ${file}. Fix or remove the file, then run again.`, {
      cause: error,
    });
  }
}

/**
 * Runs the command. Returns the exit code: 0 ok, 1 failure, 2 usage, 3 a model scored worse than before.
 * @param {{ argv: readonly string[], env?: Record<string, string | undefined>, stdout: (text: string) => void, stderr: (text: string) => void, now?: Date, rootDir?: string, fetchImpl?: typeof fetch, pollIntervalMs?: number, memorySettleMs?: number, extraPrices?: Record<string, { input_per_million: number, output_per_million: number }> }} options
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
  memorySettleMs,
  extraPrices = {},
}) {
  let args;
  try {
    args = parseModelArgs(argv);
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
    const token = await readRunnerToken({ env, envFile: path.join(rootDir, '.env.eval-tokens') });
    const client = createInstanceClient({ baseUrl: args.instance, token, fetchImpl });
    const health = await client.getHealth();
    if (!isRecord(health) || health.eval_mode !== true) {
      throw new Error(NOT_EVAL_INSTANCE_MESSAGE);
    }
    const prices = { ...extraPrices, ...(await loadPrices(args.pricesPath)) };
    const tokenSet = await loadTokenSet(path.join(rootDir, ...EVALS_DIR, 'token-set.json'));
    const modelSet = await loadModelSet(path.join(rootDir, ...EVALS_DIR, 'model-set.json'));
    const space = await loadSpaceFixture(path.join(rootDir, ...EVALS_DIR, 'fixtures', 'space.json'));
    const outDir = args.outDir ?? defaultOutDir({ rootDir, label: args.label, now });
    const result = await runEvalModels({
      client,
      tokenSet,
      modelSet,
      space,
      models: args.models,
      judgeModel: args.judge,
      prices,
      temperature: args.temperature,
      runs: args.runs,
      label: args.label,
      outDir,
      generatedAt: now,
      pollIntervalMs,
      ...(memorySettleMs === undefined ? {} : { memorySettleMs }),
      log: message => stderr(`${message}\n`),
    });
    for (const score of result.report.json.scores) {
      stdout(`${score.model}: ${String(score.passed)}/${String(score.total)} passed\n`);
    }
    let code = 0;
    if (args.historyPath !== undefined) {
      const history = await readHistory(args.historyPath);
      const drops = findDrops({ history, entry: result.report.json, maxDropPoints: args.maxDrop });
      history.entries.push(result.report.json);
      await writeFile(args.historyPath, `${JSON.stringify(history, null, 2)}\n`);
      const earlier = historyMarkdown({ history, models: args.models });
      const dropText = drops
        .map(drop => `${drop.model} passed ${String(drop.now)}%, down from ${String(drop.before)}% last time.`)
        .join('\n');
      const summary = await readFile(result.summaryPath, 'utf8');
      await writeFile(
        result.summaryPath,
        `${summary}${drops.length > 0 ? `\n## Score dropped\n\n${dropText}\n` : ''}${earlier}`,
      );
      if (drops.length > 0) {
        stderr(`${dropText}\nOpen summary.md to see which cases failed.\n`);
        code = DROP_EXIT_CODE;
      }
    }
    stdout(`Summary: ${result.summaryPath}\nCSV: ${result.csvPath}\n`);
    return code;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : 'The eval stopped for an unknown reason.'}\n`);
    return 1;
  }
}
