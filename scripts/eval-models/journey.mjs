// A case that goes past the chat: the schedule the model made is run once, and its run is checked the way a
// person would see it. Everything the case made is removed afterwards, so the next model starts the same.
import { isRunStopping, replyTextOf } from '../eval-tokens/run.mjs';

export const JOURNEYS = Object.freeze(['scheduled_run']);

/** The start of the task a morning brief schedule carries, so the check knows the model asked for a brief. */
const MORNING_BRIEF_TASK_START = 'Give me my morning brief.';

const DEFAULT_RUN_TIMEOUT_MS = 300_000;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function result({ check, pass, detail }) {
  return { check, pass, detail: pass ? '' : detail };
}

/** "morning-brief" reads "Morning brief", the way the app names a schedule's chats. */
export function plainScheduleName(name) {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The JSON a brief reply ends with, or undefined when it has none that reads as a brief. */
export function readBrief(reply) {
  const match = /```json\s*([\s\S]*?)```/.exec(reply);
  if (match === null) {
    return undefined;
  }
  try {
    const brief = JSON.parse(match[1]);
    return isRecord(brief) && typeof brief.digest === 'string' && Array.isArray(brief.items) ? brief : undefined;
  } catch {
    return undefined;
  }
}

/** What exists before a case, so only what the case made is checked and removed. */
export async function snapshotJourney({ client }) {
  const [schedules, agents] = await Promise.all([client.listSchedules(), client.listAgents()]);
  return { scheduleIds: new Set(schedules.map(item => item.id)), agentIds: new Set(agents.map(item => item.id)) };
}

async function waitForRunChat({ client, runId, pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await client.listRecentSessions();
    const chat = sessions.find(item => isRecord(item.source) && item.source.run_id === runId);
    if (chat !== undefined) {
      const last = (await client.listTurns(chat.id)).at(-1);
      const status = isRecord(last?.state) ? last.state.status : undefined;
      if (status !== undefined && status !== 'running') {
        return { chat, state: last.state };
      }
    }
    await sleep(pollIntervalMs);
  }
  return undefined;
}

/**
 * Runs the schedule the chat made and checks it like a person would: one new morning brief schedule at the
 * asked time, a run that finishes, a chat named for the schedule, and a brief in that chat.
 * @param {{ client: any, before: { scheduleIds: Set<string> }, expect: { cron: string, timezone: string }, pollIntervalMs: number, runTimeoutMs?: number }} options
 * @returns {Promise<import('./checks.mjs').CheckResult[]>}
 */
export async function checkScheduledRun({
  client,
  before,
  expect,
  pollIntervalMs,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
}) {
  const made = (await client.listSchedules()).filter(item => !before.scheduleIds.has(item.id));
  const results = [
    result({
      check: 'made one new schedule',
      pass: made.length === 1,
      detail: `made ${String(made.length)} schedules`,
    }),
  ];
  const schedule = made[0];
  if (schedule === undefined) {
    return results;
  }
  const manifest = isRecord(schedule.manifest) ? schedule.manifest : {};
  results.push(
    result({
      check: 'the schedule is a morning brief',
      pass: typeof manifest.task === 'string' && manifest.task.startsWith(MORNING_BRIEF_TASK_START),
      detail: 'its task is not the morning brief',
    }),
    result({
      check: `the schedule runs at ${expect.cron} in ${expect.timezone}`,
      pass: manifest.cron === expect.cron && manifest.timezone === expect.timezone,
      detail: `it runs at ${String(manifest.cron)} in ${String(manifest.timezone)}`,
    }),
  );
  const run = await client.runScheduleNow(schedule.id);
  const finished = await waitForRunChat({ client, runId: run.id, pollIntervalMs, timeoutMs: runTimeoutMs });
  results.push(
    result({
      check: 'the run finished',
      pass: finished?.state.status === 'done',
      detail:
        finished === undefined ? 'no finished run chat in time' : `the run ended as ${String(finished.state.status)}`,
    }),
  );
  if (finished === undefined) {
    return results;
  }
  const name = plainScheduleName(schedule.name);
  results.push(
    result({
      check: `the run's chat is named ${name}`,
      pass: typeof finished.chat.title === 'string' && finished.chat.title.startsWith(name),
      detail: `it is named ${String(finished.chat.title)}`,
    }),
    result({
      check: 'the run wrote a brief',
      pass: finished.state.status === 'done' && readBrief(replyTextOf(finished.state.output)) !== undefined,
      detail: 'the reply has no brief with a digest and items',
    }),
  );
  return results;
}

/**
 * Removes the schedules and agents a case made. Returns what could not be removed.
 * @param {{ client: any, before: { scheduleIds: Set<string>, agentIds: Set<string> } }} options
 */
export async function cleanUpJourney({ client, before }) {
  const problems = [];
  const remove = async (id, action) => {
    try {
      await action(id);
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push(id);
    }
  };
  for (const schedule of await client.listSchedules()) {
    if (!before.scheduleIds.has(schedule.id)) {
      await remove(schedule.id, id => client.deleteSchedule(id));
    }
  }
  for (const agent of await client.listAgents()) {
    if (!before.agentIds.has(agent.id)) {
      await remove(agent.id, id => client.deleteAgent(id));
    }
  }
  return problems;
}
