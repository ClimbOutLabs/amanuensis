// Hand-checked parser for space-set.json, in the style of scripts/eval-tokens/parse.mjs.
import { readFile } from 'node:fs/promises';

export const SPACE_SET_VERSION = 1;

/** Each target is checked against the measured value of the same name. */
const EXPECT_TYPES = Object.freeze({
  rows: 'count',
  duplicate_rows: 'count',
  table_valid: 'boolean',
  formatting_changed: 'boolean',
  completed: 'boolean',
  refused_or_failed_calls: 'count',
  pictures_min: 'count',
});

/**
 * @typedef {{ id: string, prompt: string, follow_up?: string, expect: Record<string, number | boolean> }} SpacePrompt
 * @typedef {{ version: 1, prompts: SpacePrompt[] }} SpaceSet
 */

export class SpaceSetError extends Error {
  /**
   * @param {string[]} problems
   * @param {{ cause?: unknown }} [options]
   */
  constructor(problems, options) {
    super(`The space set is not valid:\n- ${problems.join('\n- ')}`, options);
    this.name = 'SpaceSetError';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function expectProblems({ expect, label }) {
  if (!isPlainObject(expect) || Object.keys(expect).length === 0) {
    return [`${label}.expect must be an object with at least one target`];
  }
  const problems = [];
  for (const [name, value] of Object.entries(expect)) {
    const type = EXPECT_TYPES[name];
    if (type === undefined) {
      problems.push(`${label}.expect.${name} is not a known target (use ${Object.keys(EXPECT_TYPES).join(', ')})`);
    } else if (type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`${label}.expect.${name} must be true or false`);
    } else if (type === 'count' && !(Number.isInteger(value) && value >= 0)) {
      problems.push(`${label}.expect.${name} must be a whole number, 0 or more`);
    }
  }
  return problems;
}

/**
 * Checks the set's shape and returns a normalized copy. Throws SpaceSetError listing every problem.
 * @param {unknown} value
 * @returns {SpaceSet}
 */
export function parseSpaceSet(value) {
  if (!isPlainObject(value)) {
    throw new SpaceSetError(['the file must hold a JSON object']);
  }
  const problems = [];
  if (value.version !== SPACE_SET_VERSION) {
    problems.push(`version must be ${SPACE_SET_VERSION}`);
  }
  if (!Array.isArray(value.prompts) || value.prompts.length === 0) {
    throw new SpaceSetError([...problems, 'prompts must be a non-empty array']);
  }
  const seenIds = new Set();
  /** @type {SpacePrompt[]} */
  const prompts = [];
  value.prompts.forEach((entry, index) => {
    const where = `prompts[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { id, prompt, follow_up: followUp, expect } = entry;
    const before = problems.length;
    if (!isNonEmptyString(id)) {
      problems.push(`${where}.id must be a non-empty string`);
    } else if (seenIds.has(id)) {
      problems.push(`${where}.id "${id}" is used more than once`);
    } else {
      seenIds.add(id);
    }
    const label = isNonEmptyString(id) ? `${where} (${id})` : where;
    if (!isNonEmptyString(prompt)) {
      problems.push(`${label}.prompt must be a non-empty string`);
    }
    if (followUp !== undefined && !isNonEmptyString(followUp)) {
      problems.push(`${label}.follow_up must be a non-empty string when present`);
    }
    problems.push(...expectProblems({ expect, label }));
    if (isPlainObject(expect) && expect.formatting_changed !== undefined && followUp === undefined) {
      problems.push(`${label}.expect.formatting_changed needs a follow_up to compare against`);
    }
    if (problems.length === before) {
      prompts.push({ id, prompt, ...(followUp === undefined ? {} : { follow_up: followUp }), expect: { ...expect } });
    }
  });

  if (problems.length > 0) {
    throw new SpaceSetError(problems);
  }
  return { version: SPACE_SET_VERSION, prompts };
}

/**
 * Reads and checks a space set file.
 * @param {string} file
 * @returns {Promise<SpaceSet>}
 */
export async function loadSpaceSet(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read the space set at ${file}. Check the --set path.`, { cause: error });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SpaceSetError([`the file is not valid JSON (${error.message})`], { cause: error });
  }
  return parseSpaceSet(json);
}
