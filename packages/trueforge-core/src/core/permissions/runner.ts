/**
 * Dedicated Sentinel runner for the named Tier 2 workflows (test, lint,
 * typecheck, build). Accepts only a workflow identifier from the fixed enum
 * and no other parameters; the commands executed come from server-side
 * configuration, never from a model-supplied string.
 *
 * Known residual risk, stated plainly: the named-workflow exemption is keyed
 * on the workflow label, and the agent writes the workflow's inputs
 * (package.json scripts, Makefile targets), so an agent can route arbitrary
 * execution through a named workflow without triggering escalation.
 * Compensator: at invocation the runner best-effort resolves the workflow's
 * declared inputs to files, intersects them with the tracked executable set,
 * and names the matches in the Tier 2 indicator before execution, so a
 * watching user can intervene. During the run it records each executable file
 * it invokes; tracked-set matches are flagged in the audit feed. Limitation:
 * files loaded in-process (`require()`, `dlopen()`) by a named workflow are
 * neither resolved pre-execution nor recorded at runtime.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  canonicalFileIdentity,
  splitWordsLenient,
  type TrackedExecutableScope,
  type TrackedExecutableStore,
} from './trackedExecutables';

export const RUNNER_WORKFLOWS = ['test', 'lint', 'typecheck', 'build'] as const;
export type RunnerWorkflow = (typeof RUNNER_WORKFLOWS)[number];

export function isRunnerWorkflow(value: unknown): value is RunnerWorkflow {
  return typeof value === 'string' && RUNNER_WORKFLOWS.some(workflow => workflow === value);
}

/** Server-side commands per workflow. Never model-supplied. */
export interface RunnerServerConfig {
  commands: Record<RunnerWorkflow, readonly string[]>;
}

export function defaultRunnerServerConfig(): RunnerServerConfig {
  return {
    commands: {
      test: ['pnpm test'],
      lint: ['pnpm lint'],
      typecheck: ['pnpm typecheck'],
      build: ['pnpm build'],
    },
  };
}

/** package.json script names consulted per workflow, including lifecycle hooks. */
const WORKFLOW_SCRIPTS: Record<RunnerWorkflow, readonly string[]> = {
  test: ['pretest', 'test', 'posttest'],
  lint: ['prelint', 'lint', 'postlint'],
  typecheck: ['typecheck'],
  build: ['prebuild', 'build', 'postbuild'],
};

const FILE_TOKEN_PATTERN = /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|sh|bash|py|rb|pl|php|lua)$/i;

function defaultReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Best-effort file references inside a shell script string. */
function extractFileTokens(script: string, workspaceCwd: string): string[] {
  const files: string[] = [];
  for (const token of splitWordsLenient(script)) {
    if (token.startsWith('-') || token.includes('://')) {
      continue;
    }
    if (!FILE_TOKEN_PATTERN.test(token) && !token.includes('/')) {
      continue;
    }
    const identity = canonicalFileIdentity({ p: token, cwd: workspaceCwd });
    if (identity !== null) {
      files.push(identity);
    }
  }
  return files;
}

function packageJsonInputFiles(input: {
  workflow: RunnerWorkflow;
  workspace_cwd: string;
  readFile: (absPath: string) => string | null;
}): string[] {
  const text = input.readFile(path.join(input.workspace_cwd, 'package.json'));
  if (text === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const scripts: unknown = 'scripts' in parsed ? parsed.scripts : undefined;
  if (typeof scripts !== 'object' || scripts === null) {
    return [];
  }
  const scriptMap = new Map<string, unknown>(Object.entries(scripts));
  const files: string[] = [];
  for (const name of WORKFLOW_SCRIPTS[input.workflow]) {
    const script = scriptMap.get(name);
    if (typeof script === 'string') {
      files.push(...extractFileTokens(script, input.workspace_cwd));
    }
  }
  return files;
}

function makefileInputFiles(input: {
  workflow: RunnerWorkflow;
  workspace_cwd: string;
  readFile: (absPath: string) => string | null;
}): string[] {
  const text = input.readFile(path.join(input.workspace_cwd, 'Makefile'));
  if (text === null) {
    return [];
  }
  const files: string[] = [];
  const lines = text.split('\n');
  let inTarget = false;
  for (const line of lines) {
    const targetMatch = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (targetMatch !== null) {
      inTarget = targetMatch[1] === input.workflow;
      continue;
    }
    if (inTarget && (line.startsWith('\t') || line.startsWith(' '))) {
      files.push(...extractFileTokens(line.trim(), input.workspace_cwd));
    } else if (inTarget && line.trim() !== '' && !line.startsWith('#')) {
      inTarget = false;
    }
  }
  return files;
}

export interface ResolvedWorkflowInputs {
  /** Canonical file identities resolved from the workflow's declared inputs. */
  files: string[];
  /** Subset present in the tracked executable set: named in the Tier 2 indicator. */
  tracked_files: string[];
}

/**
 * Best-effort resolution of a named workflow's inputs to files at invocation
 * time, reading the live workflow files. Inputs that cannot be resolved to
 * files are still executed.
 */
export function resolveWorkflowInputs(input: {
  workflow: RunnerWorkflow;
  workspace_cwd: string;
  tracked_store: TrackedExecutableStore;
  scope: TrackedExecutableScope;
  readFile?: (absPath: string) => string | null;
}): ResolvedWorkflowInputs {
  const readFile = input.readFile ?? defaultReadFile;
  const seen = new Set<string>();
  const files: string[] = [];
  const pushAll = (candidates: string[]): void => {
    for (const file of candidates) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  };
  pushAll(packageJsonInputFiles({ workflow: input.workflow, workspace_cwd: input.workspace_cwd, readFile }));
  pushAll(makefileInputFiles({ workflow: input.workflow, workspace_cwd: input.workspace_cwd, readFile }));
  const trackedFiles = files.filter(file =>
    input.tracked_store.isTracked({ scope: input.scope, file_identity: file }),
  );
  return { files, tracked_files: trackedFiles };
}

export interface RunnerRuntimeRecord {
  workflow: RunnerWorkflow;
  /** Canonical identities of executable files the run invoked. */
  invoked_files: string[];
  /** Subset in the tracked set: flagged in the audit feed. */
  tracked_files: string[];
}

/** Build the runtime record from the resolved inputs plus the command binaries. */
export function buildRunnerRuntimeRecord(input: {
  workflow: RunnerWorkflow;
  resolved: ResolvedWorkflowInputs;
  command_binaries: readonly string[];
  tracked_store: TrackedExecutableStore;
  scope: TrackedExecutableScope;
}): RunnerRuntimeRecord {
  const seen = new Set<string>(input.resolved.files);
  const invoked = [...input.resolved.files];
  for (const binary of input.command_binaries) {
    if (!seen.has(binary)) {
      seen.add(binary);
      invoked.push(binary);
    }
  }
  return {
    workflow: input.workflow,
    invoked_files: invoked,
    tracked_files: invoked.filter(file =>
      input.tracked_store.isTracked({ scope: input.scope, file_identity: file }),
    ),
  };
}
