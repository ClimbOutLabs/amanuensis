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
  createdSpaceIds,
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
  'approvals',
  'completed',
  'space_id',
  'new_spaces',
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

/** The newest of these spaces, by creation time. */
function newestOf(spaces) {
  return spaces.reduce(
    (newest, space) => (newest === undefined || space.created_at >= newest.created_at ? space : newest),
    undefined,
  );
}

/**
 * Spaces this chat made: named by its own successful create_space results, and not there before it started.
 * Spaces another person makes during the run are never in this list.
 */
async function spacesMadeByChat({ client, sessionId, beforeIds }) {
  const created = createdSpaceIds(await client.listSessionEvents(sessionId));
  const spaces = await client.listAllSpaces();
  return spaces.filter(space => created.has(space.id) && !beforeIds.has(space.id));
}

/** Reads each kept revision, oldest first. Revisions the instance no longer keeps are skipped. */
async function readRevisions({ client, space }) {
  const revisions = [];
  for (let revision = 1; revision <= space.revision; revision += 1) {
    if (revision === space.revision) {
      revisions.push({ revision, body: space.body, format: space.format });
      continue;
    }
    try {
      const old = await client.getSpace({ id: space.id, revision });
      revisions.push({ revision, body: old.body, format: old.format });
    } catch (error) {
      if (!(error instanceof InstanceHttpError && error.status === 404)) {
        throw error;
      }
    }
  }
  return revisions;
}

/** Deletes the spaces this chat made. A failure names the space so it can be removed by hand. */
async function removeChatSpaces({ client, sessionId, beforeIds }) {
  const problems = [];
  for (const space of await spacesMadeByChat({ client, sessionId, beforeIds })) {
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
  const progress = { turns: [], approvals: 0 };
  let status;
  let space;
  let madeByChat = [];
  let spaceBeforeFollowUp;
  let followUpRan = false;
  // Unknown until the first listing works. Cleanup never runs without it.
  let beforeIds;
  let sessionId;
  const drive = options =>
    driveTurns({ client, approvalPolicy: 'approve', pollIntervalMs, turnTimeoutMs, progress, ...options });
  try {
    beforeIds = new Set((await client.listAllSpaces()).map(entry => entry.id));
    sessionId = await client.createSession({ model, temperature });
    status = await drive({
      sessionId,
      input: [{ type: 'user.message', content: prompt.prompt }],
      previousTurnId: 'none',
    });
    if (prompt.follow_up !== undefined && status === 'done') {
      spaceBeforeFollowUp = newestOf(await spacesMadeByChat({ client, sessionId, beforeIds }));
      status = await drive({
        sessionId,
        input: [{ type: 'user.message', content: prompt.follow_up }],
        previousTurnId: progress.turns.at(-1).id,
      });
      followUpRan = true;
    }
    madeByChat = await spacesMadeByChat({ client, sessionId, beforeIds });
    space = newestOf(madeByChat);
    const terminal = describeTerminalState(progress.turns.at(-1)?.state ?? {});
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

  const { turns } = progress;
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
    approvals: progress.approvals,
    space_id: space?.id,
    new_spaces: madeByChat.length,
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
    if (status !== 'request_failed') {
      problems.push('No new space was found after the chat.');
    }
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
    try {
      row.rows_lost = findRowsLost({ revisions: await readRevisions({ client, space }) });
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push('Could not read the earlier versions of the space, so rows_lost is empty.');
    }
  }
  if (prompt.follow_up !== undefined) {
    // Only one space, the same before and after the follow-up, can show a formatting pass.
    const sameSpace =
      followUpRan &&
      spaceBeforeFollowUp !== undefined &&
      madeByChat.length === 1 &&
      space?.id === spaceBeforeFollowUp.id;
    if (sameSpace) {
      row.formatting_changed = isFormattingChanged({ before: spaceBeforeFollowUp.body, after: space.body });
    } else {
      row.formatting_changed = false;
      problems.push(
        followUpRan
          ? 'The follow-up did not leave one space to compare, so formatting_changed is false.'
          : 'The follow-up did not run, so formatting_changed is false.',
      );
    }
  }
  row.completed = status === 'done' && space !== undefined && reply.trim() !== '';
  // A chat that did not finish meets no target, whatever the stored space looks like.
  const failed =
    status === 'done'
      ? failedExpectations({ measures: row, expect: prompt.expect })
      : [
          `status ${String(status)} is not done`,
          ...Object.keys(prompt.expect).map(name => `${name} not met because the chat did not finish`),
        ];
  row.expectations_met = failed.length === 0;
  row.failed_expectations = failed.join('; ');

  if (!keep) {
    if (beforeIds === undefined || sessionId === undefined) {
      problems.push(
        'The spaces list could not be read before the chat, so nothing was deleted. Check the instance for spaces to remove.',
      );
    } else {
      try {
        problems.push(...(await removeChatSpaces({ client, sessionId, beforeIds })));
      } catch (error) {
        if (isRunStopping(error)) {
          throw error;
        }
        problems.push('Could not clean up the spaces this chat made. Delete them by hand in the eval instance.');
      }
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
