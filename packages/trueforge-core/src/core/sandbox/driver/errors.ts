import type { DriverTermination } from './IsolationDriver';
import type { RunCodeErrorCode } from './RunCodeSchemas';

/** Maps a driver's termination report onto the model-visible error taxonomy. */
export function errorCodeForTermination(input: {
  terminatedBy: DriverTermination;
  exitCode: number;
  oomKilled: boolean;
}): RunCodeErrorCode {
  if (input.terminatedBy === 'timeout') {
    return 'timeout';
  }
  if (input.terminatedBy === 'oom' || input.oomKilled) {
    return 'memory_exceeded';
  }
  if (input.terminatedBy === 'disk') {
    return 'disk_exceeded';
  }
  if (input.terminatedBy === 'killed') {
    return 'internal';
  }
  if (input.terminatedBy === 'internal') {
    return 'internal';
  }
  return 'internal';
}

/**
 * Human-actionable error text per code. Short, no stack traces, no host paths
 * (paths are scrubbed separately). Carries the anti-workaround rule: a
 * run_code failure must never become an exec workaround.
 */
export function errorTextForCode(input: { error_code: RunCodeErrorCode; detail: string | undefined }): string {
  const detail = input.detail !== undefined && input.detail !== '' ? `: ${input.detail}` : '';
  switch (input.error_code) {
    case 'timeout':
      return (
        `The code exceeded its time limit and was stopped${detail}. ` +
        `If run_code fails, do NOT fall back to exec (or any shell tool) to run the code — ` +
        `interpreter invocations in exec are rejected by a harness guard. ` +
        `Make the code faster, split the work, or report the failure.`
      );
    case 'memory_exceeded':
      return (
        `The code exceeded its memory limit and was stopped${detail}. ` +
        `If run_code fails, do NOT fall back to exec (or any shell tool) to run the code — ` +
        `interpreter invocations in exec are rejected by a harness guard. ` +
        `Reduce the data held in memory, process in chunks, or report the failure.`
      );
    case 'disk_exceeded':
      return (
        `The code exceeded its disk quota and was stopped${detail}. ` +
        `If run_code fails, do NOT fall back to exec (or any shell tool) to run the code — ` +
        `interpreter invocations in exec are rejected by a harness guard. ` +
        `Write less data to /scratch and /egress, or report the failure.`
      );
    case 'output_exceeded':
      return `Output exceeded the transport bound${detail}. Narrow what the code prints.`;
    case 'image_unavailable':
      return `The sandbox image is unavailable${detail}.`;
    case 'daemon_unavailable':
      return `The sandbox backend is unavailable${detail}.`;
    case 'docker_unavailable':
      // The detail carries the complete user-facing message (the driver sets
      // the spec's exact wording); surface it unchanged. The fallback covers
      // a driver that reports the code without detail, which never happens.
      return input.detail !== undefined && input.detail !== ''
        ? input.detail
        : 'The sandbox backend is unavailable: Docker was not detected on this machine.';
    case 'isolation_refused':
      // The detail carries the complete user-facing message (the driver sets
      // the spec's exact wording); surface it unchanged.
      return input.detail !== undefined && input.detail !== ''
        ? input.detail
        : 'The sandbox could not apply all isolation guarantees, so the code was not executed.';
    case 'concurrency_exceeded':
      return `Too many concurrent run_code executions${detail}. Wait for one to finish and retry.`;
    case 'invalid_input':
      return `Invalid run_code input${detail}.`;
    case 'internal':
      return `The sandbox failed internally${detail}. If run_code fails, do NOT fall back to exec to run the code.`;
  }
}

/**
 * Host-path scrubber (S10): every model-visible error string passes through
 * here. The run-root and data-dir prefixes become `<sandbox>/`. Only exact
 * prefixes are replaced — sandbox-internal paths (/ingress, /scratch, …) and
 * interpreter tracebacks inside the sandbox are left intact.
 */
export function scrubHostPaths(input: { text: string; runRoot: string; dataDir: string }): string {
  let out = input.text;
  for (const prefix of [input.runRoot, input.dataDir]) {
    if (prefix !== '') {
      out = out.split(prefix).join('<sandbox>/');
    }
  }
  return out;
}
