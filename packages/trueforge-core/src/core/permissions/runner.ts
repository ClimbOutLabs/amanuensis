/**
 * Sentinel runner workflow identifiers.
 *
 * The named workflows (test, lint, typecheck, build) are classified as Tier 3
 * by the tier classifier, since the agent controls the workflow inputs
 * (package.json scripts, Makefile targets) and can route arbitrary execution
 * through a named workflow.
 */
export const RUNNER_WORKFLOWS = ['test', 'lint', 'typecheck', 'build'] as const;
export type RunnerWorkflow = (typeof RUNNER_WORKFLOWS)[number];

export function isRunnerWorkflow(value: unknown): value is RunnerWorkflow {
  return typeof value === 'string' && RUNNER_WORKFLOWS.some(workflow => workflow === value);
}
