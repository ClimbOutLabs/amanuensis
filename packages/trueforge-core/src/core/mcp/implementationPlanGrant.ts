import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';

export const IMPLEMENTATION_PLAN_GRANT_KIND = 'implementation_plan.v1';

const MAX_PLAN_FILE_GLOBS = 128;
const MAX_PLAN_FILE_GLOB_LENGTH = 512;
const MAX_PLAN_VERIFY_COMMANDS = 64;
const MAX_PLAN_VERIFY_COMMAND_ID_LENGTH = 256;
const MAX_IMPLEMENTATION_PLAN_SCOPE_PATHS = 512;
const MAX_IMPLEMENTATION_PLAN_SCOPE_PATH_LENGTH = 1_024;
const MAX_GLOB_MATCH_OPERATIONS = 4_000_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const ImplementationPlanSchema = z
  .object({
    repository_id: z
      .string()
      .min(1)
      .refine(id => id.length <= 256, 'must be at most 256 characters'),
    repository_revision: z.number().int().nonnegative(),
    branch: z
      .string()
      .min(1)
      .refine(branch => branch.length <= 512, 'must be at most 512 characters'),
    head_sha: z.string().min(1).max(128),
    file_globs: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            glob => glob.length <= MAX_PLAN_FILE_GLOB_LENGTH,
            `must be at most ${String(MAX_PLAN_FILE_GLOB_LENGTH)} characters`,
          )
          .refine(glob => compileRepositoryGlob(glob) !== undefined, 'File globs must be repository-relative patterns'),
      )
      .min(1)
      .max(MAX_PLAN_FILE_GLOBS),
    approach: z
      .string()
      .trim()
      .min(1)
      .refine(approach => approach.length <= 4_000, 'must be at most 4000 characters'),
    verify_command_ids: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            id => id.length <= MAX_PLAN_VERIFY_COMMAND_ID_LENGTH,
            `must be at most ${String(MAX_PLAN_VERIFY_COMMAND_ID_LENGTH)} characters`,
          ),
      )
      .min(1)
      .max(MAX_PLAN_VERIFY_COMMANDS),
  })
  .strict()
  .openapi('ImplementationPlan');

export const ImplementationPlanGrantSchema = z
  .object({
    kind: z.literal(IMPLEMENTATION_PLAN_GRANT_KIND),
    grant_id: z.string().min(1),
    plan_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    tenant_id: z.string().min(1),
    created_by: z.string().min(1),
    session_id: z.string().min(1),
    workspace_cwd: z.string().min(1).max(4_096),
    checkout_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    plan: ImplementationPlanSchema,
  })
  .strict()
  .openapi('ImplementationPlanGrant');

export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
export type ImplementationPlanGrant = z.infer<typeof ImplementationPlanGrantSchema>;

export const ImplementationPlanBindingSchema = z
  .object({
    repository_id: z.string().min(1).max(256),
    repository_revision: z.number().int().nonnegative(),
    workspace_cwd: z.string().min(1).max(4_096),
    checkout_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    branch: z.string().min(1).max(512),
    head_sha: z.string().min(1).max(128),
  })
  .strict();

export type ImplementationPlanBinding = z.infer<typeof ImplementationPlanBindingSchema>;

export interface ImplementationPlanGrantOwner {
  tenant_id: string;
  created_by: string;
  session_id: string;
}

export interface ImplementationPlanCheckoutIdentityInput {
  provider_type: string;
  sandbox_id: string;
  repository_root: string;
  git_dir: string;
  checkout_nodes: string;
}

/** Integrity identity for one concrete checkout inside one provider sandbox. */
export function implementationPlanCheckoutId(input: ImplementationPlanCheckoutIdentityInput): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.provider_type,
        input.sandbox_id,
        input.repository_root,
        input.git_dir,
        input.checkout_nodes,
      ]),
      'utf8',
    )
    .digest('hex');
  return `sha256:${digest}`;
}

export const ImplementationPlanGrantScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('paths'),
      paths: z
        .array(z.string().min(1).max(MAX_IMPLEMENTATION_PLAN_SCOPE_PATH_LENGTH))
        .min(1)
        .max(MAX_IMPLEMENTATION_PLAN_SCOPE_PATHS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      command_id: z.string().min(1).max(MAX_PLAN_VERIFY_COMMAND_ID_LENGTH),
    })
    .strict(),
]);

export type ImplementationPlanGrantScope = z.infer<typeof ImplementationPlanGrantScopeSchema>;

function canonicalPlan(plan: ImplementationPlan): ImplementationPlan {
  return ImplementationPlanSchema.parse({
    ...plan,
    file_globs: [...new Set(plan.file_globs)].sort(),
    verify_command_ids: [...new Set(plan.verify_command_ids)].sort(),
  });
}

/** Host-derived durable identity. It is intentionally distinct from legacy v3 tool grants. */
export function mintImplementationPlanGrant(
  input: ImplementationPlanGrantOwner & { workspace_cwd: string; checkout_id: string; plan: ImplementationPlan },
): ImplementationPlanGrant {
  const plan = canonicalPlan(input.plan);
  const planHash = createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.tenant_id,
        input.created_by,
        input.session_id,
        input.workspace_cwd,
        input.checkout_id,
        planHash,
      ]),
      'utf8',
    )
    .digest('hex');
  return ImplementationPlanGrantSchema.parse({
    kind: IMPLEMENTATION_PLAN_GRANT_KIND,
    grant_id: `plan-${digest}`,
    plan_hash: `sha256:${planHash}`,
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    session_id: input.session_id,
    workspace_cwd: input.workspace_cwd,
    checkout_id: input.checkout_id,
    plan,
  });
}

export function serializeImplementationPlanGrant(grant: ImplementationPlanGrant): string {
  return JSON.stringify(grant);
}

/** Keeps plan envelopes out of the legacy approval_grants channel, including tampered grants. */
export function isSerializedImplementationPlanGrant(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      parsed.kind === IMPLEMENTATION_PLAN_GRANT_KIND
    );
  } catch {
    return false;
  }
}

export function parseImplementationPlanGrant(value: string): ImplementationPlanGrant | undefined {
  try {
    return validateImplementationPlanGrant(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Validates persisted/API values and returns the one canonical representation. */
export function validateImplementationPlanGrant(value: unknown): ImplementationPlanGrant | undefined {
  const parsed = ImplementationPlanGrantSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const expected = mintImplementationPlanGrant({
    tenant_id: parsed.data.tenant_id,
    created_by: parsed.data.created_by,
    session_id: parsed.data.session_id,
    workspace_cwd: parsed.data.workspace_cwd,
    checkout_id: parsed.data.checkout_id,
    plan: parsed.data.plan,
  });
  return expected.grant_id === parsed.data.grant_id && expected.plan_hash === parsed.data.plan_hash
    ? expected
    : undefined;
}

type GlobInstruction =
  | { kind: 'literal'; value: string }
  | { kind: 'single_character' }
  | { kind: 'segment_wildcard' }
  | { kind: 'recursive_wildcard' }
  | { kind: 'recursive_directories_start' }
  | { kind: 'recursive_directories_consumed' };

interface GlobMatchBudget {
  remaining: number;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isSafeRepositoryRelativeValue(value: string, maximumLength: number): boolean {
  return !(
    value.length === 0 ||
    value.length > maximumLength ||
    containsControlCharacter(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-z]:/iu.test(value) ||
    value.startsWith('//') ||
    value.split('/').some(part => part === '..' || part === '.' || part.length === 0)
  );
}

function compileRepositoryGlob(glob: string): GlobInstruction[] | undefined {
  if (!isSafeRepositoryRelativeValue(glob, MAX_PLAN_FILE_GLOB_LENGTH)) {
    return undefined;
  }
  const characters = Array.from(GRAPHEME_SEGMENTER.segment(glob), part => part.segment);
  const instructions: GlobInstruction[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index];
    const next = characters[index + 1];
    if (character === '*' && next === '*') {
      if (characters[index + 2] === '/') {
        instructions.push({ kind: 'recursive_directories_start' }, { kind: 'recursive_directories_consumed' });
        index += 3;
      } else {
        instructions.push({ kind: 'recursive_wildcard' });
        index += 2;
      }
    } else if (character === '*') {
      instructions.push({ kind: 'segment_wildcard' });
      index += 1;
    } else if (character === '?') {
      instructions.push({ kind: 'single_character' });
      index += 1;
    } else {
      if (character === undefined) {
        return undefined;
      }
      instructions.push({ kind: 'literal', value: character });
      index += 1;
    }
  }
  return instructions;
}

function spendGlobMatchOperation(budget: GlobMatchBudget): boolean {
  if (budget.remaining <= 0) {
    return false;
  }
  budget.remaining -= 1;
  return true;
}

function addGlobEpsilonTransitions(
  active: Uint8Array,
  instructions: readonly GlobInstruction[],
  budget: GlobMatchBudget,
): boolean {
  for (let index = 0; index < instructions.length; index += 1) {
    if (!spendGlobMatchOperation(budget)) {
      return false;
    }
    if (active[index] !== 1) {
      continue;
    }
    const instruction = instructions[index];
    if (instruction === undefined) {
      return false;
    }
    if (instruction.kind === 'segment_wildcard' || instruction.kind === 'recursive_wildcard') {
      active[index + 1] = 1;
    } else if (instruction.kind === 'recursive_directories_start') {
      active[index + 2] = 1;
    }
  }
  return true;
}

/** Thompson-style NFA simulation: bounded by pattern length × path length, with no backtracking. */
function repositoryGlobMatches(input: {
  instructions: readonly GlobInstruction[];
  path: string;
  budget: GlobMatchBudget;
}): boolean {
  let active = new Uint8Array(input.instructions.length + 1);
  active[0] = 1;
  if (!addGlobEpsilonTransitions(active, input.instructions, input.budget)) {
    return false;
  }

  for (const { segment: character } of GRAPHEME_SEGMENTER.segment(input.path)) {
    const next = new Uint8Array(input.instructions.length + 1);
    for (let index = 0; index < input.instructions.length; index += 1) {
      if (!spendGlobMatchOperation(input.budget)) {
        return false;
      }
      if (active[index] !== 1) {
        continue;
      }
      const instruction = input.instructions[index];
      if (instruction === undefined) {
        return false;
      }
      if (instruction.kind === 'literal') {
        if (instruction.value === character) {
          next[index + 1] = 1;
        }
      } else if (instruction.kind === 'single_character') {
        if (character !== '/') {
          next[index + 1] = 1;
        }
      } else if (instruction.kind === 'segment_wildcard') {
        if (character !== '/') {
          next[index] = 1;
        }
      } else if (instruction.kind === 'recursive_wildcard') {
        next[index] = 1;
      } else if (instruction.kind === 'recursive_directories_start') {
        next[index + 1] = 1;
        if (character === '/') {
          next[index + 2] = 1;
        }
      } else {
        next[index] = 1;
        if (character === '/') {
          next[index + 1] = 1;
        }
      }
    }
    if (!addGlobEpsilonTransitions(next, input.instructions, input.budget)) {
      return false;
    }
    active = next;
  }
  return active[input.instructions.length] === 1;
}

export function implementationPlanAllowsPaths(input: {
  grant: ImplementationPlanGrant;
  paths: readonly string[];
}): boolean {
  if (input.paths.length === 0 || input.paths.length > MAX_IMPLEMENTATION_PLAN_SCOPE_PATHS) {
    return false;
  }
  const patterns = input.grant.plan.file_globs.map(compileRepositoryGlob);
  if (patterns.some(pattern => pattern === undefined)) {
    return false;
  }
  const budget: GlobMatchBudget = { remaining: MAX_GLOB_MATCH_OPERATIONS };
  return input.paths.every(path => {
    if (!isSafeRepositoryRelativeValue(path, MAX_IMPLEMENTATION_PLAN_SCOPE_PATH_LENGTH)) {
      return false;
    }
    return patterns.some(pattern =>
      pattern === undefined ? false : repositoryGlobMatches({ instructions: pattern, path, budget }),
    );
  });
}

export function implementationPlanAllowsCommand(input: {
  grant: ImplementationPlanGrant;
  command_id: string;
}): boolean {
  return input.grant.plan.verify_command_ids.includes(input.command_id);
}

export function implementationPlanMatchesBinding(input: {
  grant: ImplementationPlanGrant;
  binding: ImplementationPlanBinding;
}): boolean {
  return (
    input.grant.plan.repository_id === input.binding.repository_id &&
    input.grant.plan.repository_revision === input.binding.repository_revision &&
    input.grant.workspace_cwd === input.binding.workspace_cwd &&
    input.grant.checkout_id === input.binding.checkout_id &&
    input.grant.plan.branch === input.binding.branch &&
    input.grant.plan.head_sha === input.binding.head_sha
  );
}

/** Central scope matcher; adding a future structured write tool only requires a new scope extractor. */
export function implementationPlanAllowsScope(input: {
  grant: ImplementationPlanGrant;
  scope: ImplementationPlanGrantScope;
}): boolean {
  return input.scope.kind === 'paths'
    ? implementationPlanAllowsPaths({ grant: input.grant, paths: input.scope.paths })
    : implementationPlanAllowsCommand({ grant: input.grant, command_id: input.scope.command_id });
}
