// Hand-checked parser for token-set.json. The root has no schema library, so the
// rules live here as one function instead of a second copy in the docs.
import { readFile } from 'node:fs/promises';

/** Must match the `group` values in packages/trueforge/evals/token-set.json. */
export const GROUPS = Object.freeze(['calendar', 'email', 'map', 'web_search', 'shared_doc', 'adversarial']);
export const APPROVAL_POLICIES = Object.freeze(['approve', 'decline']);
export const TOKEN_SET_VERSION = 1;
export const PROMPT_COUNT = 18;
const CHECKLIST_MIN = 3;
const CHECKLIST_MAX = 5;

/**
 * @typedef {{ id: string, group: string, prompt: string, approval_policy: 'approve' | 'decline', checklist: string[] }} EvalPrompt
 * @typedef {{ version: 1, prompts: EvalPrompt[] }} TokenSet
 */

export class TokenSetError extends Error {
  /**
   * @param {string[]} problems
   * @param {{ cause?: unknown }} [options]
   */
  constructor(problems, options) {
    super(`token-set.json is not valid:\n- ${problems.join('\n- ')}`, options);
    this.name = 'TokenSetError';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Checks the set's shape and returns a normalized copy. Throws TokenSetError listing every problem.
 * @param {unknown} value
 * @returns {TokenSet}
 */
export function parseTokenSet(value) {
  if (!isPlainObject(value)) {
    throw new TokenSetError(['the file must hold a JSON object']);
  }
  const problems = [];
  if (value.version !== TOKEN_SET_VERSION) {
    problems.push(`version must be ${TOKEN_SET_VERSION}`);
  }
  if (!Array.isArray(value.prompts)) {
    throw new TokenSetError([...problems, 'prompts must be an array']);
  }
  if (value.prompts.length !== PROMPT_COUNT) {
    problems.push(`expected ${PROMPT_COUNT} prompts, found ${value.prompts.length}`);
  }

  const seenIds = new Set();
  /** @type {EvalPrompt[]} */
  const prompts = [];
  value.prompts.forEach((entry, index) => {
    const where = `prompts[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { id, group, prompt, approval_policy: policy, checklist } = entry;
    if (!isNonEmptyString(id)) {
      problems.push(`${where}.id must be a non-empty string`);
    } else if (seenIds.has(id)) {
      problems.push(`${where}.id "${id}" is used more than once`);
    } else {
      seenIds.add(id);
    }
    const label = isNonEmptyString(id) ? `${where} (${id})` : where;
    if (!GROUPS.includes(group)) {
      problems.push(`${label}.group must be one of ${GROUPS.join(', ')}`);
    }
    if (!isNonEmptyString(prompt)) {
      problems.push(`${label}.prompt must be a non-empty string`);
    }
    if (!APPROVAL_POLICIES.includes(policy)) {
      problems.push(`${label}.approval_policy must be "approve" or "decline"`);
    }
    if (!Array.isArray(checklist) || !checklist.every(isNonEmptyString)) {
      problems.push(`${label}.checklist must be an array of strings`);
    } else if (checklist.length < CHECKLIST_MIN || checklist.length > CHECKLIST_MAX) {
      problems.push(`${label}.checklist must have ${CHECKLIST_MIN} to ${CHECKLIST_MAX} items`);
    }
    if (
      isNonEmptyString(id) &&
      GROUPS.includes(group) &&
      isNonEmptyString(prompt) &&
      APPROVAL_POLICIES.includes(policy) &&
      Array.isArray(checklist) &&
      checklist.every(isNonEmptyString)
    ) {
      prompts.push({ id, group, prompt, approval_policy: policy, checklist: [...checklist] });
    }
  });

  if (problems.length > 0) {
    throw new TokenSetError(problems);
  }
  return { version: TOKEN_SET_VERSION, prompts };
}

/**
 * Reads and checks a token set file.
 * @param {string} file
 * @returns {Promise<TokenSet>}
 */
export async function loadTokenSet(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read the token set at ${file}. Check the --set path.`, { cause: error });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TokenSetError([`the file is not valid JSON (${error.message})`], { cause: error });
  }
  return parseTokenSet(json);
}
