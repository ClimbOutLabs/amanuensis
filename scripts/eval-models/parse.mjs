// Hand-checked parser for model-set.json. The root has no schema library, so the rules live here.
import { readFile } from 'node:fs/promises';
import { APPROVAL_POLICIES } from '../eval-tokens/parse.mjs';
import { JOURNEYS } from './journey.mjs';
import { SHARED_VAULT } from './personas.mjs';

/** Must match the `group` values in packages/trueforge/evals/model-set.json. */
export const MODEL_SET_GROUPS = Object.freeze(['memory', 'safety', 'brief', 'persona', 'skills', 'web']);
export const MODEL_SET_VERSION = 7;
/** The Personalization page fields a set may fill in for the run. */
const PROFILE_FIELDS = Object.freeze(['user_name', 'address_as']);
export const CHECK_TYPES = Object.freeze([
  'reply_includes',
  'reply_excludes',
  'tool_called',
  'no_tool',
  'no_tool_args_include',
  'refused_commands_at_most',
]);

/**
 * @typedef {{ type: 'reply_includes', any: string[] }
 *   | { type: 'reply_excludes', all: string[] }
 *   | { type: 'tool_called', tools: string[] }
 *   | { type: 'no_tool', tools: string[] }
 *   | { type: 'no_tool_args_include', any: string[] }
 *   | { type: 'refused_commands_at_most', max: number }} Check
 * @typedef {{ type: 'scheduled_run', cron: string, timezone: string, brief_checks?: Check[] }
 *   | { type: 'memory_saved', words: string[], saved_in: string[], not_saved_in: string[] }
 *   | { type: 'skill_added', websites: string[] }
 *   | { type: 'skill_removed' }
 *   | { type: 'news_titles', at_least: number }} Journey
 * @typedef {{ prompt: string, checks: Check[], journey?: Journey }} CaseStep
 * @typedef {{ id: string, group: string, prompt: string, approval_policy: 'approve' | 'decline', checks: Check[], checklist: string[], client_timezone?: string, journey?: Journey, persona?: string, incognito?: boolean, steps?: CaseStep[] }} ModelCase
 * @typedef {{ text: string, timestamp: string }} SeedMemory
 * @typedef {{ name: string, instructions: string, memories: SeedMemory[] }} SetPersona
 * @typedef {{ version: 7, memories: SeedMemory[], profile?: Record<string, string>, personas: SetPersona[], cases: ModelCase[] }} ModelSet
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
  if (check.type === 'refused_commands_at_most') {
    if (!Number.isInteger(check.max) || check.max < 0) {
      problems.push(`${where}.max must be a whole number, 0 or more`);
      return undefined;
    }
    return { type: check.type, max: check.max };
  }
  const field = CHECK_LIST_FIELD[check.type];
  if (!isTextList(check[field])) {
    problems.push(`${where}.${field} must be a non-empty list of strings`);
    return undefined;
  }
  return { type: check.type, [field]: [...check[field]] };
}

/** @returns {SeedMemory[]} */
function parseMemories(value, where, problems) {
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  const memories = [];
  value.forEach((entry, index) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.text) || Number.isNaN(Date.parse(entry.timestamp))) {
      problems.push(`${where}[${String(index)}] needs text and a timestamp such as 2026-08-04T09:10:00Z`);
      return;
    }
    memories.push({ text: entry.text, timestamp: entry.timestamp });
  });
  return memories;
}

/** @returns {Record<string, string> | undefined} */
function parseProfile(value, problems) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isPlainObject(value) ||
    Object.keys(value).length === 0 ||
    !Object.entries(value).every(([key, text]) => PROFILE_FIELDS.includes(key) && isNonEmptyString(text))
  ) {
    problems.push(`profile may only fill in ${PROFILE_FIELDS.join(', ')}, each with text`);
    return undefined;
  }
  return { ...value };
}

/** @returns {SetPersona[]} */
function parsePersonas(value, problems) {
  if (!Array.isArray(value)) {
    problems.push('personas must be a list');
    return [];
  }
  const personas = [];
  value.forEach((entry, index) => {
    const where = `personas[${String(index)}]`;
    if (!isPlainObject(entry) || !isNonEmptyString(entry.name) || !isNonEmptyString(entry.instructions)) {
      problems.push(`${where} needs a name and instructions`);
      return;
    }
    if (entry.name === SHARED_VAULT || personas.some(persona => persona.name === entry.name)) {
      problems.push(`${where}.name must be unique and not "${SHARED_VAULT}"`);
      return;
    }
    personas.push({
      name: entry.name,
      instructions: entry.instructions,
      memories: parseMemories(entry.memories ?? [], `${where}.memories`, problems),
    });
  });
  return personas;
}

/** @returns {Journey | undefined} */
function parseJourney(journey, label, { vaults, problems }) {
  if (isPlainObject(journey) && journey.type === 'scheduled_run') {
    if (isNonEmptyString(journey.cron) && isNonEmptyString(journey.timezone)) {
      const parsed = { type: journey.type, cron: journey.cron, timezone: journey.timezone };
      if (journey.brief_checks !== undefined) {
        // A brief is judged on its words alone, so only the reply checks make sense here.
        const briefChecks = [];
        const rawChecks = Array.isArray(journey.brief_checks) ? journey.brief_checks : [];
        rawChecks.forEach((raw, index) => {
          const check = parseCheck(raw, `${label}.journey.brief_checks[${String(index)}]`, problems);
          if (check !== undefined && (check.type === 'reply_includes' || check.type === 'reply_excludes')) {
            briefChecks.push(check);
          } else if (check !== undefined) {
            problems.push(`${label}.journey.brief_checks[${String(index)}] must be a reply_includes or reply_excludes check`);
          }
        });
        if (Array.isArray(journey.brief_checks) && journey.brief_checks.length > 0 && briefChecks.length > 0) {
          parsed.brief_checks = briefChecks;
        } else if (!Array.isArray(journey.brief_checks) || journey.brief_checks.length === 0) {
          problems.push(`${label}.journey.brief_checks must be a non-empty list of checks`);
        }
      }
      return parsed;
    }
    problems.push(`${label}.journey of type scheduled_run needs a cron and a timezone`);
    return undefined;
  }
  if (isPlainObject(journey) && journey.type === 'memory_saved') {
    const isVaultList = list => Array.isArray(list) && list.every(vault => vaults.includes(vault));
    if (
      isTextList(journey.words) &&
      isVaultList(journey.saved_in) &&
      isVaultList(journey.not_saved_in) &&
      journey.not_saved_in.length > 0
    ) {
      return {
        type: journey.type,
        words: [...journey.words],
        saved_in: [...journey.saved_in],
        not_saved_in: [...journey.not_saved_in],
      };
    }
    problems.push(
      `${label}.journey of type memory_saved needs words, saved_in and a non-empty not_saved_in, naming only ${vaults.join(', ')}`,
    );
    return undefined;
  }
  if (isPlainObject(journey) && journey.type === 'skill_added') {
    const websites = journey.websites ?? [];
    if (Array.isArray(websites) && websites.every(isNonEmptyString)) {
      return { type: journey.type, websites: [...websites] };
    }
    problems.push(`${label}.journey of type skill_added takes websites, a list of host names`);
    return undefined;
  }
  if (isPlainObject(journey) && journey.type === 'skill_removed') {
    return { type: journey.type };
  }
  if (isPlainObject(journey) && journey.type === 'news_titles') {
    if (Number.isInteger(journey.at_least) && journey.at_least > 0) {
      return { type: journey.type, at_least: journey.at_least };
    }
    problems.push(`${label}.journey of type news_titles needs at_least, a whole number above 0`);
    return undefined;
  }
  problems.push(`${label}.journey needs a type (${JOURNEYS.join(', ')})`);
  return undefined;
}

/**
 * The messages of a case that runs in one chat, one after another, each with its own checks.
 * @returns {CaseStep[] | undefined}
 */
function parseSteps(value, label, { vaults, problems }) {
  if (!Array.isArray(value) || value.length < 2) {
    problems.push(`${label}.steps must be a list of at least two messages`);
    return undefined;
  }
  return value.map((step, index) => {
    const where = `${label}.steps[${String(index)}]`;
    if (!isPlainObject(step) || !isNonEmptyString(step.prompt)) {
      problems.push(`${where} needs a prompt`);
      return { prompt: '', checks: [] };
    }
    const rawChecks = Array.isArray(step.checks) ? step.checks : [];
    if (rawChecks.length === 0 && step.journey === undefined) {
      problems.push(`${where} needs at least one check or a journey, or it can never fail`);
    }
    const checks = rawChecks
      .map((check, checkIndex) => parseCheck(check, `${where}.checks[${String(checkIndex)}]`, problems))
      .filter(check => check !== undefined);
    const journey = step.journey === undefined ? undefined : parseJourney(step.journey, where, { vaults, problems });
    return { prompt: step.prompt, checks, ...(journey === undefined ? {} : { journey }) };
  });
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
  if (!Array.isArray(value.cases)) {
    throw new ModelSetError([...problems, 'cases must be a list']);
  }

  const memories = parseMemories(value.memories, 'memories', problems);
  const profile = parseProfile(value.profile, problems);
  const personas = parsePersonas(value.personas ?? [], problems);
  const vaults = [SHARED_VAULT, ...personas.map(persona => persona.name)];

  const seenIds = new Set();
  /** @type {ModelCase[]} */
  const cases = [];
  value.cases.forEach((entry, index) => {
    const where = `cases[${String(index)}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { id, group, approval_policy: policy } = entry;
    const label = isNonEmptyString(id) ? `${where} (${id})` : where;
    const before = problems.length;
    const steps = entry.steps === undefined ? undefined : parseSteps(entry.steps, label, { vaults, problems });
    // A case of several messages is read as one prompt by the judge and the report.
    const prompt = steps === undefined ? entry.prompt : steps.map(step => step.prompt).join('\n\n');
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
    if (entry.steps === undefined && !isNonEmptyString(prompt)) {
      problems.push(`${label}.prompt must be a non-empty string`);
    }
    if (
      entry.steps !== undefined &&
      (entry.prompt !== undefined || entry.checks !== undefined || entry.journey !== undefined)
    ) {
      problems.push(`${label} has steps, so its prompt, checks and journey belong in the steps`);
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
    if (
      Array.isArray(rawChecks) &&
      Array.isArray(rawChecklist) &&
      rawChecks.length + rawChecklist.length === 0 &&
      entry.journey === undefined &&
      steps === undefined
    ) {
      problems.push(`${label} needs at least one check, checklist item or journey, or it can never fail`);
    }
    const zone = entry.client_timezone;
    if (zone !== undefined && !isNonEmptyString(zone)) {
      problems.push(`${label}.client_timezone must be a time zone name such as Europe/London`);
    }
    const journey = entry.journey === undefined ? undefined : parseJourney(entry.journey, label, { vaults, problems });
    const persona = entry.persona;
    if (persona !== undefined && !personas.some(item => item.name === persona)) {
      problems.push(`${label}.persona must name one of the set's personas`);
    }
    const incognito = entry.incognito;
    if (incognito !== undefined && typeof incognito !== 'boolean') {
      problems.push(`${label}.incognito must be true or false`);
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
        ...(journey === undefined ? {} : { journey }),
        ...(persona === undefined ? {} : { persona }),
        ...(incognito === true ? { incognito } : {}),
        ...(steps === undefined ? {} : { steps }),
      });
    }
  });

  if (problems.length > 0) {
    throw new ModelSetError(problems);
  }
  return { version: MODEL_SET_VERSION, memories, ...(profile === undefined ? {} : { profile }), personas, cases };
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
