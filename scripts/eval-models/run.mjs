// Runs every case on every model, grades the replies, and writes the comparison.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  combineTurnMetrics,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  describeTerminalState,
  driveTurns,
  isRunStopping,
  replyTextOf,
} from '../eval-tokens/run.mjs';
import { removeSpace, seedSpace } from '../eval-tokens/space.mjs';
import { collectToolCalls, runChecks } from './checks.mjs';
import { buildJudgePrompt, parseVerdict } from './judge.mjs';
import { buildReport, RESULT_CSV_COLUMNS, resultCsv } from './report.mjs';

/** Which part of the score a group counts toward. Every token-set group is an everyday task. */
export function partOf(group) {
  return group === 'memory' || group === 'safety' ? group : 'tasks';
}

const DEFAULT_MEMORY_SETTLE_MS = 3000;
const MEMORY_SETTLE_POLLS = 10;
const JUDGE_ATTEMPTS = 2;

const ignoreLog = () => undefined;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The cases in the order they run: memory first, so earlier chats of the same run have not yet
 * been remembered, then safety, then the everyday tasks from the token set.
 * @param {{ modelSet: import('./parse.mjs').ModelSet, tokenSet: import('../eval-tokens/parse.mjs').TokenSet }} options
 */
export function orderedCases({ modelSet, tokenSet }) {
  const byGroup = group => modelSet.cases.filter(item => item.group === group);
  return [...byGroup('memory'), ...byGroup('safety'), ...tokenSet.prompts.map(prompt => ({ ...prompt, checks: [] }))];
}

/**
 * Finds each requested model on the instance. Unknown names stop the run before anything is sent.
 * @param {{ client: ReturnType<import('../eval-tokens/client.mjs').createInstanceClient>, names: string[] }} options
 */
export async function resolveModels({ client, names }) {
  const [models, providers] = await Promise.all([client.listModels(), client.listModelProviders()]);
  const missing = names.filter(name => !models.some(model => model.name === name));
  if (missing.length > 0) {
    const known = models.map(model => model.name).join(', ') || '(none)';
    throw new Error(
      `The eval instance has no model named ${missing.join(', ')}. Add it in Settings, or pick one of: ${known}.`,
    );
  }
  return names.map(name => {
    const model = models.find(item => item.name === name);
    const provider = providers.find(item => item.name === model?.provider?.name);
    return { name, model_id: model?.model_id, provider_type: provider?.type };
  });
}

/** Cost from the server's own Token Factory counters: today's cost for one model id. */
function tokenFactoryCost({ usage, modelId }) {
  const entry = usage.models.find(model => model.model_id === modelId);
  return entry === undefined ? 0 : entry.cost_usd;
}

/**
 * Cost of one model's part of the run. A price given with --prices wins. Otherwise a Token Factory
 * model is priced by the instance, from its counters before and after. Anything else stays unknown.
 */
export function modelCost({ model, prices, inputTokens, outputTokens, usageBefore, usageAfter }) {
  const price = prices[model.name];
  if (price !== undefined) {
    return (inputTokens * price.input_per_million + outputTokens * price.output_per_million) / 1_000_000;
  }
  if (model.provider_type !== 'tokenfactory' || usageBefore === undefined || usageAfter === undefined) {
    return undefined;
  }
  if (usageBefore.usage_date !== usageAfter.usage_date) {
    return undefined;
  }
  const before = tokenFactoryCost({ usage: usageBefore, modelId: model.model_id });
  const after = tokenFactoryCost({ usage: usageAfter, modelId: model.model_id });
  return before === null || after === null ? undefined : Math.max(after - before, 0);
}

async function readUsage(client) {
  try {
    return await client.getTokenFactoryUsage();
  } catch (error) {
    if (isRunStopping(error)) {
      throw error;
    }
    return undefined;
  }
}

/** Waits until the memory stops growing, since the instance saves a finished chat after it replies. */
async function settledMemory({ client, settleMs }) {
  let previous = -1;
  let entries = [];
  for (let poll = 0; poll < MEMORY_SETTLE_POLLS; poll += 1) {
    entries = await client.listMemoryEntries();
    if (entries.length === previous) {
      return entries;
    }
    previous = entries.length;
    await sleep(settleMs);
  }
  return entries;
}

/** Removes every memory added since `beforeIds`: the seeded facts and whatever the run's chats left behind. */
async function removeRunMemories({ client, beforeIds, settleMs }) {
  const problems = [];
  for (const entry of await settledMemory({ client, settleMs })) {
    if (beforeIds.has(entry.id)) {
      continue;
    }
    try {
      await client.deleteMemoryEntry(entry.id);
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push(entry.id);
    }
  }
  return problems;
}

async function runCase({ client, model, testCase, temperature, run, pollIntervalMs, turnTimeoutMs }) {
  const progress = { turns: [], approvals: 0 };
  let status;
  let error;
  let toolCalls = [];
  try {
    const sessionId = await client.createSession({ model: model.name, temperature });
    status = await driveTurns({
      client,
      sessionId,
      input: [{ type: 'user.message', content: testCase.prompt }],
      previousTurnId: 'none',
      approvalPolicy: testCase.approval_policy,
      pollIntervalMs,
      turnTimeoutMs,
      progress,
    });
    error = describeTerminalState(progress.turns.at(-1)?.state ?? {});
    toolCalls = collectToolCalls(await client.listSessionEvents(sessionId));
  } catch (caught) {
    if (isRunStopping(caught)) {
      throw caught;
    }
    status = status ?? 'request_failed';
    error = caught instanceof Error ? caught.message : 'Unknown request failure.';
  }
  const last = progress.turns.at(-1);
  const reply = last !== undefined && last.state.status === 'done' ? replyTextOf(last.state.output) : '';
  return {
    run,
    model: model.name,
    case_id: testCase.id,
    part: partOf(testCase.group),
    group: testCase.group,
    status,
    error,
    approvals: progress.approvals,
    ...combineTurnMetrics(progress.turns.map(turn => turn.state.metrics)),
    reply,
    tool_calls: toolCalls,
    checks: status === 'done' ? runChecks({ checks: testCase.checks, reply, toolCalls }) : [],
    checklist: testCase.checklist,
    prompt: testCase.prompt,
    judged: [],
  };
}

/** One judge chat, asked again once when its answer cannot be read. */
async function judgeRow({ client, judgeModel, row, pollIntervalMs, turnTimeoutMs }) {
  const prompt = buildJudgePrompt({
    prompt: row.prompt,
    reply: row.reply,
    toolCalls: row.tool_calls,
    checklist: row.checklist,
  });
  for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt += 1) {
    const progress = { turns: [], approvals: 0 };
    try {
      const sessionId = await client.createSession({ model: judgeModel, temperature: 0, incognito: true });
      const status = await driveTurns({
        client,
        sessionId,
        input: [{ type: 'user.message', content: prompt }],
        previousTurnId: 'none',
        approvalPolicy: 'decline',
        pollIntervalMs,
        turnTimeoutMs,
        progress,
      });
      const last = progress.turns.at(-1);
      if (status === 'done' && last !== undefined) {
        const verdict = parseVerdict({ text: replyTextOf(last.state.output), count: row.checklist.length });
        if (verdict !== undefined) {
          return verdict;
        }
      }
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
    }
  }
  return row.checklist.map(() => ({ pass: false, reason: 'The judge could not grade this reply.' }));
}

/** A case passes when the chat finished and every rule check and every judged item passed. */
export function rowPasses(row) {
  return (
    row.status === 'done' &&
    row.checks.every(check => check.pass) &&
    row.judged.length === row.checklist.length &&
    row.judged.every(item => item.pass)
  );
}

/**
 * @param {{
 *   client: ReturnType<import('../eval-tokens/client.mjs').createInstanceClient>,
 *   tokenSet: import('../eval-tokens/parse.mjs').TokenSet,
 *   modelSet: import('./parse.mjs').ModelSet,
 *   space: Record<string, string>,
 *   models: string[],
 *   judgeModel: string,
 *   prices?: Record<string, { input_per_million: number, output_per_million: number }>,
 *   temperature: number,
 *   runs: number,
 *   label: string,
 *   outDir: string,
 *   generatedAt?: Date,
 *   pollIntervalMs?: number,
 *   turnTimeoutMs?: number,
 *   memorySettleMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runEvalModels({
  client,
  tokenSet,
  modelSet,
  space,
  models,
  judgeModel,
  prices = {},
  temperature,
  runs,
  label,
  outDir,
  generatedAt = new Date(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  memorySettleMs = DEFAULT_MEMORY_SETTLE_MS,
  log = ignoreLog,
}) {
  const resolved = await resolveModels({ client, names: [...new Set([...models, judgeModel])] });
  const testedModels = resolved.filter(model => models.includes(model.name));
  const judge = resolved.find(model => model.name === judgeModel);
  const cases = orderedCases({ modelSet, tokenSet });
  const rows = [];
  const costs = {};
  const cleanupProblems = [];

  const seeded = await seedSpace({ client, content: space });
  try {
    for (const model of testedModels) {
      const beforeIds = new Set((await client.listMemoryEntries()).map(entry => entry.id));
      const usageBefore = await readUsage(client);
      const modelRows = [];
      try {
        await client.importMemories(modelSet.memories);
        for (let run = 1; run <= runs; run += 1) {
          for (const testCase of cases) {
            log(`${model.name}  run ${String(run)}/${String(runs)}  ${testCase.id}`);
            modelRows.push(await runCase({ client, model, testCase, temperature, run, pollIntervalMs, turnTimeoutMs }));
          }
        }
      } finally {
        cleanupProblems.push(...(await removeRunMemories({ client, beforeIds, settleMs: memorySettleMs })));
      }
      const usageAfter = await readUsage(client);
      costs[model.name] = modelCost({
        model,
        prices,
        inputTokens: modelRows.reduce((total, row) => total + (row.input_tokens ?? 0), 0),
        outputTokens: modelRows.reduce((total, row) => total + (row.output_tokens ?? 0), 0),
        usageBefore,
        usageAfter,
      });
      rows.push(...modelRows);
    }
  } finally {
    await removeSpace({ client, seeded });
  }

  const usageBeforeJudge = await readUsage(client);
  for (const row of rows) {
    if (row.checklist.length === 0 || row.status !== 'done') {
      continue;
    }
    log(`judge  ${row.model}  ${row.case_id}`);
    row.judged = await judgeRow({ client, judgeModel, row, pollIntervalMs, turnTimeoutMs });
  }
  const judgeCost =
    judge === undefined
      ? undefined
      : modelCost({
          model: judge,
          prices: {},
          inputTokens: 0,
          outputTokens: 0,
          usageBefore: usageBeforeJudge,
          usageAfter: await readUsage(client),
        });
  for (const row of rows) {
    row.pass = rowPasses(row);
  }

  const report = buildReport({
    label,
    generatedAt: generatedAt.toISOString(),
    origin: client.origin,
    judgeModel,
    judgeCost,
    runs,
    temperature,
    setVersions: { token_set: tokenSet.version, model_set: modelSet.version },
    models: testedModels.map(model => model.name),
    costs,
    rows,
    cleanupProblems,
  });
  await mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'results.csv');
  const summaryPath = path.join(outDir, 'summary.md');
  const jsonPath = path.join(outDir, 'results.json');
  await writeFile(csvPath, resultCsv(rows));
  await writeFile(summaryPath, report.markdown);
  await writeFile(jsonPath, `${JSON.stringify({ ...report.json, rows }, null, 2)}\n`);
  return { rows, report, csvPath, summaryPath, jsonPath, columns: RESULT_CSV_COLUMNS };
}
