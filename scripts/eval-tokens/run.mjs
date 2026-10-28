// Drives every prompt through the chat API and writes the CSV and the markdown summary.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InstanceHttpError, InstanceUnreachableError } from './client.mjs';
import { REPLY_CSV_COLUMNS, toCsv } from './csv.mjs';
import { removeSpace, seedSpace } from './space.mjs';
import { buildSummary } from './summary.mjs';

export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** Stops a prompt that keeps asking for approval from looping forever. */
const MAX_APPROVAL_ROUNDS = 5;
const DECLINE_REASON = 'Declined by the token eval runner.';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ignoreLog = () => undefined;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The reply text lives in `content`, as a string or as text parts. */
export function replyTextOf(output) {
  if (!isRecord(output)) {
    return '';
  }
  if (typeof output.content === 'string') {
    return output.content;
  }
  if (Array.isArray(output.content)) {
    return output.content.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function sumNumbers(values) {
  const numbers = values.filter(value => typeof value === 'number');
  return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0);
}

function lastNumber(values) {
  const numbers = values.filter(value => typeof value === 'number');
  return numbers.at(-1);
}

function firstNumber(values) {
  return values.find(value => typeof value === 'number');
}

/** Adds per-key counts across records. Missing records contribute nothing. */
function mergeCounts(records) {
  const present = records.filter(isRecord);
  if (present.length === 0) {
    return undefined;
  }
  const merged = {};
  for (const record of present) {
    for (const [key, count] of Object.entries(record)) {
      if (typeof count === 'number') {
        merged[key] = (merged[key] ?? 0) + count;
      }
    }
  }
  return merged;
}

/**
 * One reply can span several turns when approvals resume it. Counts add up across those turns,
 * the first time to first token wins, and the last call's input size comes from the final turn.
 * @param {unknown[]} metricsList
 */
export function combineTurnMetrics(metricsList) {
  const list = metricsList.filter(isRecord);
  const values = key => list.map(metrics => metrics[key]);
  const booleans = values('claim_mismatch').filter(value => typeof value === 'boolean');
  return {
    steps: sumNumbers(values('steps')),
    sub_agent_steps: sumNumbers(values('sub_agent_steps')),
    input_tokens: sumNumbers(values('total_input_tokens')),
    output_tokens: sumNumbers(values('total_output_tokens')),
    cached_input_tokens: sumNumbers(values('total_cache_read_tokens')),
    reasoning_tokens: sumNumbers(values('total_reasoning_tokens')),
    last_call_input_tokens: lastNumber(values('last_call_input_tokens')),
    tool_calls_by_tool: mergeCounts(values('tool_calls_by_tool')),
    results_by_kind: mergeCounts(values('results_by_kind')),
    guard_fired: values('guard_fired').find(value => typeof value === 'string'),
    claim_mismatch: booleans.length === 0 ? undefined : booleans.some(value => value),
    wall_time_ms: sumNumbers(values('wall_time_ms')),
    time_to_first_token_ms: firstNumber(values('time_to_first_token_ms')),
  };
}

/**
 * Answers every pending tool approval with the prompt's policy. Returns undefined when the pause
 * asks for something the runner cannot answer, such as a client tool or a sign-in.
 */
export function approvalDecisions(actions, policy) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return undefined;
  }
  const approval =
    policy === 'approve' ? { status: 'allow', scope: 'once' } : { status: 'deny', reason: DECLINE_REASON };
  const decisions = [];
  for (const action of actions) {
    if (
      !isRecord(action) ||
      action.type !== 'tool.approval_required' ||
      typeof action.thread_id !== 'string' ||
      !Array.isArray(action.tool_calls)
    ) {
      return undefined;
    }
    for (const call of action.tool_calls) {
      if (!isRecord(call) || typeof call.id !== 'string') {
        return undefined;
      }
      decisions.push({ type: 'user.tool_approval', thread_id: action.thread_id, tool_call_id: call.id, approval });
    }
  }
  return decisions;
}

/** Errors that mean every later call would fail too, so the run stops instead of writing empty rows. */
export function isRunStopping(error) {
  if (error instanceof InstanceUnreachableError) {
    return true;
  }
  return error instanceof InstanceHttpError && (error.status === 401 || error.status === 403);
}

async function waitForFinish({ client, sessionId, turnId, pollIntervalMs, turnTimeoutMs }) {
  const deadline = Date.now() + turnTimeoutMs;
  for (;;) {
    const turn = await client.getTurn(sessionId, turnId);
    if (turn.state.status !== 'running') {
      return turn;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(pollIntervalMs);
  }
}

export function describeTerminalState(state) {
  if (state.status === 'error' && typeof state.message === 'string') {
    return state.message;
  }
  if (state.status === 'cancelled' && typeof state.reason === 'string') {
    return `Cancelled: ${state.reason}`;
  }
  return '';
}

/**
 * Sends one input and follows the chat until it settles, answering approval cards with the policy.
 * `status` is the last turn's status, or a runner status when the chat could not be followed.
 */
export async function driveTurns({
  client,
  sessionId,
  input,
  previousTurnId,
  approvalPolicy,
  pollIntervalMs,
  turnTimeoutMs,
}) {
  const turns = [];
  let approvals = 0;
  let status;
  let pending = await client.createTurn(sessionId, { input, previous_turn_id: previousTurnId });
  for (let round = 0; ; round += 1) {
    const finished = await waitForFinish({ client, sessionId, turnId: pending.id, pollIntervalMs, turnTimeoutMs });
    if (finished === undefined) {
      status = 'timeout';
      break;
    }
    turns.push(finished);
    const { state } = finished;
    status = state.status;
    if (state.status !== 'done' || !Array.isArray(state.required_actions) || state.required_actions.length === 0) {
      break;
    }
    const decisions = approvalDecisions(state.required_actions, approvalPolicy);
    if (decisions === undefined) {
      status = 'needs_action';
      break;
    }
    if (round >= MAX_APPROVAL_ROUNDS) {
      status = 'too_many_approvals';
      break;
    }
    approvals += decisions.length;
    pending = await client.createTurn(sessionId, { input: decisions, previous_turn_id: finished.id });
  }
  return { turns, approvals, status };
}

async function runOnePrompt({ client, prompt, model, temperature, run, label, pollIntervalMs, turnTimeoutMs }) {
  let turns = [];
  let approvals = 0;
  let status;
  let errorText;
  try {
    const sessionId = await client.createSession({ model, temperature });
    ({ turns, approvals, status } = await driveTurns({
      client,
      sessionId,
      input: [{ type: 'user.message', content: prompt.prompt }],
      previousTurnId: 'none',
      approvalPolicy: prompt.approval_policy,
      pollIntervalMs,
      turnTimeoutMs,
    }));
    errorText = describeTerminalState(turns.at(-1)?.state ?? {});
  } catch (error) {
    if (isRunStopping(error)) {
      throw error;
    }
    status = 'request_failed';
    errorText = error instanceof Error ? error.message : 'Unknown request failure.';
  }

  const last = turns.at(-1);
  const reply = last !== undefined && last.state.status === 'done' ? replyTextOf(last.state.output) : '';
  const metrics = combineTurnMetrics(turns.map(turn => turn.state.metrics));
  return {
    run,
    prompt_id: prompt.id,
    group: prompt.group,
    label,
    model,
    status,
    error: errorText,
    approvals,
    ...metrics,
    reply,
    checklist: prompt.checklist.join(' | '),
    pass: '',
  };
}

/**
 * @param {{
 *   client: ReturnType<import('./client.mjs').createInstanceClient>,
 *   tokenSet: import('./parse.mjs').TokenSet,
 *   space: Record<string, string>,
 *   model: string,
 *   temperature: number,
 *   runs: number,
 *   label: string,
 *   outDir: string,
 *   generatedAt?: Date,
 *   pollIntervalMs?: number,
 *   turnTimeoutMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runEvalTokens({
  client,
  tokenSet,
  space,
  model,
  temperature,
  runs,
  label,
  outDir,
  generatedAt = new Date(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = ignoreLog,
}) {
  const seeded = await seedSpace({ client, content: space });
  const rows = [];
  try {
    for (let run = 1; run <= runs; run += 1) {
      for (const prompt of tokenSet.prompts) {
        log(`run ${String(run)}/${String(runs)}  ${prompt.id}`);
        rows.push(
          await runOnePrompt({ client, prompt, model, temperature, run, label, pollIntervalMs, turnTimeoutMs }),
        );
      }
    }
  } finally {
    await removeSpace({ client, seeded });
  }

  await mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'replies.csv');
  const summaryPath = path.join(outDir, 'summary.md');
  await writeFile(csvPath, toCsv(REPLY_CSV_COLUMNS, rows));
  await writeFile(
    summaryPath,
    buildSummary({
      label,
      model,
      temperature,
      runs,
      origin: client.origin,
      generatedAt: generatedAt.toISOString(),
      prompts: tokenSet.prompts,
      rows,
    }),
  );
  return { rows, csvPath, summaryPath };
}
