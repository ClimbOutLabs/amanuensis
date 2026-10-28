// Replays each space prompt in its own chat, finds the space it made, and scores what was stored.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InstanceHttpError } from '../eval-tokens/client.mjs';
import { toCsv } from '../eval-tokens/csv.mjs';
import {
  combineTurnMetrics,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  describeTerminalState,
  driveTurns,
  isRunStopping,
  replyTextOf,
} from '../eval-tokens/run.mjs';
import {
  countBoldLines,
  countDuplicates,
  countPictures,
  countRawListMarkers,
  countRows,
  failedExpectations,
  findRowsLost,
  isFormattingChanged,
  isTableValid,
  replyNamesSpace,
} from './score.mjs';
import { buildSpaceSummary } from './summary.mjs';

/** Column order is the contract for reading results side by side. */
export const SPACE_CSV_COLUMNS = Object.freeze([
  'run',
  'prompt_id',
  'label',
  'model',
  'status',
  'error',
  'completed',
  'space_id',
  'create_calls',
  'edit_calls',
  'refused_or_failed_calls',
  'guard_fired',
  'steps',
  'input_tokens',
  'rows',
  'duplicate_rows',
  'table_valid',
  'raw_list_markers',
  'bold_lines',
  'pictures',
  'closing_line',
  'formatting_changed',
  'rows_lost',
  'wall_time_ms',
  'expectations_met',
  'failed_expectations',
  'reply',
]);

const ignoreLog = () => undefined;

function countOf(counts, key) {
  return typeof counts?.[key] === 'number' ? counts[key] : 0;
}

function refusedOrFailed(resultsByKind) {
  if (resultsByKind === undefined) {
    return undefined;
  }
  return countOf(resultsByKind, 'error') + countOf(resultsByKind, 'unavailable') + countOf(resultsByKind, 'refused');
}

/** The newest space that was not in the list before the run. */
function newestNewSpace({ spaces, beforeIds }) {
  return spaces
    .filter(space => !beforeIds.has(space.id))
    .reduce(
      (newest, space) => (newest === undefined || space.created_at >= newest.created_at ? space : newest),
      undefined,
    );
}

/** Reads each kept revision, oldest first. Revisions the instance no longer keeps are skipped. */
async function readRevisions({ client, space }) {
  const revisions = [];
  for (let revision = 1; revision <= space.revision; revision += 1) {
    if (revision === space.revision) {
      revisions.push({ revision, body: space.body });
      continue;
    }
    try {
      const old = await client.getSpace({ id: space.id, revision });
      revisions.push({ revision, body: old.body });
    } catch (error) {
      if (!(error instanceof InstanceHttpError && error.status === 404)) {
        throw error;
      }
    }
  }
  return revisions;
}

/** Deletes every space the run added. A failure names the space so it can be removed by hand. */
async function removeNewSpaces({ client, beforeIds }) {
  const problems = [];
  const spaces = await client.listAllSpaces();
  for (const space of spaces.filter(entry => !beforeIds.has(entry.id))) {
    try {
      await client.deleteSpace({ id: space.id, expected_revision: space.revision });
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push(`Could not remove the space ${space.id}. Delete it by hand in the eval instance.`);
    }
  }
  return problems;
}

async function runOnePrompt({ client, prompt, model, temperature, run, label, keep, pollIntervalMs, turnTimeoutMs }) {
  const problems = [];
  const turns = [];
  let status;
  let space;
  let spaceBeforeFollowUp;
  let beforeIds = new Set();
  const drive = options => driveTurns({ client, approvalPolicy: 'approve', pollIntervalMs, turnTimeoutMs, ...options });
  try {
    beforeIds = new Set((await client.listAllSpaces()).map(entry => entry.id));
    const sessionId = await client.createSession({ model, temperature });
    const first = await drive({
      sessionId,
      input: [{ type: 'user.message', content: prompt.prompt }],
      previousTurnId: 'none',
    });
    turns.push(...first.turns);
    status = first.status;
    if (prompt.follow_up !== undefined && status === 'done') {
      spaceBeforeFollowUp = newestNewSpace({ spaces: await client.listAllSpaces(), beforeIds });
      const second = await drive({
        sessionId,
        input: [{ type: 'user.message', content: prompt.follow_up }],
        previousTurnId: turns.at(-1).id,
      });
      turns.push(...second.turns);
      status = second.status;
    }
    space = newestNewSpace({ spaces: await client.listAllSpaces(), beforeIds });
    const terminal = describeTerminalState(turns.at(-1)?.state ?? {});
    if (terminal !== '') {
      problems.push(terminal);
    }
  } catch (error) {
    if (isRunStopping(error)) {
      throw error;
    }
    status = 'request_failed';
    problems.push(error instanceof Error ? error.message : 'Unknown request failure.');
  }

  const last = turns.at(-1);
  const reply = last !== undefined && last.state.status === 'done' ? replyTextOf(last.state.output) : '';
  const metrics = combineTurnMetrics(turns.map(turn => turn.state.metrics));
  const toolCalls = metrics.tool_calls_by_tool;
  const row = {
    run,
    prompt_id: prompt.id,
    label,
    model,
    status,
    space_id: space?.id,
    create_calls: toolCalls === undefined ? undefined : countOf(toolCalls, 'create_space'),
    edit_calls: toolCalls === undefined ? undefined : countOf(toolCalls, 'edit_space'),
    refused_or_failed_calls: refusedOrFailed(metrics.results_by_kind),
    guard_fired: metrics.guard_fired,
    steps: metrics.steps,
    input_tokens: metrics.input_tokens,
    wall_time_ms: metrics.wall_time_ms,
    reply,
  };
  if (space === undefined) {
    problems.push('No new space was found after the chat.');
  } else {
    const scored = { body: space.body, format: space.format };
    Object.assign(row, {
      rows: countRows(scored),
      duplicate_rows: countDuplicates(scored),
      table_valid: isTableValid(scored),
      raw_list_markers: countRawListMarkers(scored),
      bold_lines: countBoldLines(scored),
      pictures: countPictures(scored),
      closing_line: replyNamesSpace({ reply, name: space.name }),
    });
    if (prompt.follow_up !== undefined) {
      row.formatting_changed = isFormattingChanged({ before: spaceBeforeFollowUp?.body ?? '', after: space.body });
    }
    try {
      row.rows_lost = findRowsLost({ revisions: await readRevisions({ client, space }), format: space.format });
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push('Could not read the earlier versions of the space, so rows_lost is empty.');
    }
  }
  row.completed = status === 'done' && space !== undefined && reply.trim() !== '';
  const failed = failedExpectations({ measures: row, expect: prompt.expect });
  row.expectations_met = failed.length === 0;
  row.failed_expectations = failed.join('; ');

  if (!keep) {
    try {
      problems.push(...(await removeNewSpaces({ client, beforeIds })));
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push('Could not clean up the spaces this chat made. Delete them by hand in the eval instance.');
    }
  }
  row.error = problems.join(' ');
  return row;
}

/**
 * @param {{
 *   client: ReturnType<import('../eval-tokens/client.mjs').createInstanceClient>,
 *   spaceSet: import('./parse.mjs').SpaceSet,
 *   model: string,
 *   temperature: number,
 *   runs: number,
 *   label: string,
 *   outDir: string,
 *   keep?: boolean,
 *   generatedAt?: Date,
 *   pollIntervalMs?: number,
 *   turnTimeoutMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runEvalSpaces({
  client,
  spaceSet,
  model,
  temperature,
  runs,
  label,
  outDir,
  keep = false,
  generatedAt = new Date(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = ignoreLog,
}) {
  const rows = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const prompt of spaceSet.prompts) {
      log(`run ${String(run)}/${String(runs)}  ${prompt.id}`);
      rows.push(
        await runOnePrompt({ client, prompt, model, temperature, run, label, keep, pollIntervalMs, turnTimeoutMs }),
      );
    }
  }
  await mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'replies.csv');
  const summaryPath = path.join(outDir, 'summary.md');
  await writeFile(csvPath, toCsv(SPACE_CSV_COLUMNS, rows));
  await writeFile(
    summaryPath,
    buildSpaceSummary({
      label,
      model,
      temperature,
      runs,
      keep,
      origin: client.origin,
      generatedAt: generatedAt.toISOString(),
      prompts: spaceSet.prompts,
      rows,
    }),
  );
  return { rows, csvPath, summaryPath };
}
