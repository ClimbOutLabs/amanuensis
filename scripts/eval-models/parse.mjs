// Hand-checked parser for model-set.json. The root has no schema library, so the rules live here.
import { readFile } from 'node:fs/promises';
import { APPROVAL_POLICIES } from '../eval-tokens/parse.mjs';
import { JOURNEYS } from './journey.mjs';

/** Must match the `group` values in packages/trueforge/evals/model-set.json. */
export const MODEL_SET_GROUPS = Object.freeze(['memory', 'safety', 'brief']);
export const MODEL_SET_VERSION = 2;
export const CHECK_TYPES = Object.freeze([
  'reply_includes',
  'reply_excludes',
  'tool_called',
  'no_tool',
  'no_tool_args_include',
]);

/**
 * @typedef {{ type: 'reply_includes', any: string[] }
 *   | { type: 'reply_excludes', all: string[] }
 *   | { type: 'tool_called', tools: string[] }
 *   | { type: 'no_tool', tools: string[] }
 *   | { type: 'no_tool_args_include', any: string[] }} Check
 * @typedef {{ type: 'scheduled_run', cron: string, timezone: string }} Journey
 * @typedef {{ id: string, group: string, prompt: string, approval_policy: 'approve' | 'decline', checks: Check[], checklist: string[], client_timezone?: string, journey?: Journey }} ModelCase
 * @typedef {{ text: string, timestamp: string }} SeedMemory
 * @typedef {{ version: 2, memories: SeedMemory[], cases: ModelCase[] }} ModelSet
 */

export class ModelSetError extends Error {
  /**
   * @param {string[]} problems
   * @param {{ cause?: unknown }} [options]
   */
  constructor(problems, options) {
    super(`model-set.json is not valid:\n- ${problems.join('\n- ')}`, options);
    this.name = 'ModelSetError';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** The list field each check type reads. */
const CHECK_LIST_FIELD = Object.freeze({
  reply_includes: 'any',
  reply_excludes: 'all',
  tool_called: 'tools',
  no_tool: 'tools',
  no_tool_args_include: 'any',
});

/**
 * @param {unknown} check
 * @param {string} where
 * @param {string[]} problems
 * @returns {Check | undefined}
 */
function parseCheck(check, where, problems) {
  if (!isPlainObject(check) || !CHECK_TYPES.includes(check.type)) {
    problems.push(`${where}.type must be one of ${CHECK_TYPES.join(', ')}`);
    return undefined;
  }
  const field = CHECK_LIST_FIELD[check.type];
  if (!isTextList(check[field])) {
    problems.push(`${where}.${field} must be a non-empty list of strings`);
    return undefined;
  }
  return { type: check.type, [field]: [...check[field]] };
}

/**
 * Checks the set's shape and returns a normalized copy. Throws ModelSetError listing every problem.
 * @param {unknown} value
 * @returns {ModelSet}
 */
export function parseModelSet(value) {
  if (!isPlainObject(value)) {
    throw new ModelSetError(['the file must hold a JSON object']);
  }
  const problems = [];
  if (value.version !== MODEL_SET_VERSION) {
    problems.push(`version must be ${String(MODEL_SET_VERSION)}`);
  }
  if (!Array.isArray(value.memories) || !Array.isArray(value.cases)) {
    throw new ModelSetError([...problems, 'memories and cases must be arrays']);
  }

  /** @type {SeedMemory[]} */
  const memories = [];
  value.memories.forEach((entry, index) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.text) || Number.isNaN(Date.parse(entry.timestamp))) {
      problems.push(`memories[${String(index)}] needs text and a timestamp such as 2026-08-04T09:10:00Z`);
      return;
    }
    memories.push({ text: entry.text, timestamp: entry.timestamp });
  });

  const seenIds = new Set();
  /** @type {ModelCase[]} */
  const cases = [];
  value.cases.forEach((entry, index) => {
    const where = `cases[${String(index)}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { id, group, prompt, approval_policy: policy } = entry;
    const label = isNonEmptyString(id) ? `${where} (${id})` : where;
    const before = problems.length;
    if (!isNonEmptyString(id)) {
      problems.push(`${where}.id must be a non-empty string`);
    } else if (seenIds.has(id)) {
      problems.push(`${label}.id is used more than once`);
    } else {
      seenIds.add(id);
    }
    if (!MODEL_SET_GROUPS.includes(group)) {
      problems.push(`${label}.group must be one of ${MODEL_SET_GROUPS.join(', ')}`);
    }
    if (!isNonEmptyString(prompt)) {
      problems.push(`${label}.prompt must be a non-empty string`);
    }
    if (!APPROVAL_POLICIES.includes(policy)) {
      problems.push(`${label}.approval_policy must be "approve" or "decline"`);
    }
    const rawChecks = entry.checks ?? [];
    const rawChecklist = entry.checklist ?? [];
    if (!Array.isArray(rawChecks)) {
      problems.push(`${label}.checks must be a list`);
    }
    if (!Array.isArray(rawChecklist) || !rawChecklist.every(isNonEmptyString)) {
      problems.push(`${label}.checklist must be a list of strings`);
    }
    if (Array.isArray(rawChecks) && Array.isArray(rawChecklist) && rawChecks.length + rawChecklist.length === 0) {
      problems.push(`${label} needs at least one check or checklist item, or it can never fail`);
    }
    const zone = entry.client_timezone;
    if (zone !== undefined && !isNonEmptyString(zone)) {
      problems.push(`${label}.client_timezone must be a time zone name such as Europe/London`);
    }
    const journey = entry.journey;
    if (
      journey !== undefined &&
      (!isPlainObject(journey) ||
        !JOURNEYS.includes(journey.type) ||
        !isNonEmptyString(journey.cron) ||
        !isNonEmptyString(journey.timezone))
    ) {
      problems.push(`${label}.journey needs a type (${JOURNEYS.join(', ')}), a cron and a timezone`);
    }
    const checks = Array.isArray(rawChecks)
      ? rawChecks.map((check, checkIndex) => parseCheck(check, `${label}.checks[${String(checkIndex)}]`, problems))
      : [];
    if (problems.length === before) {
      cases.push({
        id,
        group,
        prompt,
        approval_policy: policy,
        checks: checks.filter(check => check !== undefined),
        checklist: [...rawChecklist],
        ...(zone === undefined ? {} : { client_timezone: zone }),
        ...(journey === undefined
          ? {}
          : { journey: { type: journey.type, cron: journey.cron, timezone: journey.timezone } }),
      });
    }
  });

  if (problems.length > 0) {
    throw new ModelSetError(problems);
  }
  return { version: MODEL_SET_VERSION, memories, cases };
}

/**
 * Reads and checks a model set file.
 * @param {string} file
 * @returns {Promise<ModelSet>}
 */
export async function loadModelSet(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read the model set at ${file}. Check the --model-set path.`, { cause: error });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ModelSetError([`the file is not valid JSON (${error.message})`], { cause: error });
  }
  return parseModelSet(json);
}
