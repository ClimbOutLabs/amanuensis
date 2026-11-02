import { parseSimpleShellCommand, type SimpleShellCommand } from './simpleShellCommand';

/**
 * Exit code semantics for sandbox commands.
 *
 * A command that ran has exactly two possible statuses:
 * - "ok": exit 0, or a non-zero exit from a single simple command (`parseSimpleShellCommand`
 *   accepts it: no pipeline, list, redirection, background execution, leading assignment, or
 *   substitution anywhere in its name or arguments) whose bare name - or, for `git grep`, the
 *   literal adjacent name pair - is in the search/diff table below.
 * - "exited": every other non-zero exit, from any command shape (a pipeline, a list, a wrapped
 *   command like `env`/`timeout`/`sudo`, a substitution, a redirection, a plain command not in
 *   the table, or an unparseable command). This never guesses at success or failure: it reports
 *   `exit_code` and `error_summary` the same as "ok" does, plus a `note` saying the host does not
 *   interpret exit codes beyond the documented search and diff cases.
 *
 * There is deliberately no table of wrapper command names (`env`, `timeout`, `sudo`, ...) to
 * unwrap and look inside: unwrapping one wrapper just moves the guess to the next one a model
 * happens to use. A wrapped invocation is not a bare simple command, full stop, so it reports
 * "exited" like any other non-simple shape.
 *
 * `"failed"` is reserved for the host's own failures, never for a command that ran: the command
 * could not be started, was killed by the execution timeout, or was refused by policy before it
 * ever reached the sandbox. See `buildExecResultShape`'s `sandboxSuccess` branch.
 */

export type ExecStatus = 'ok' | 'failed' | 'exited';

export interface ExecResultShape {
  status: ExecStatus;
  exit_code: number;
  error_summary: string | null;
  success: boolean;
  /** Set only when status is "exited": explains why no "ok" verdict was made. */
  note: string | null;
}

export const EXITED_NOTE =
  'Non-zero exit; the host does not interpret exit codes beyond the documented search and diff cases. Read the output to judge.';

/** Explicit note for the grep family's benign exit 1, so the model reads "no matches" rather
 * than inferring it from a bare non-zero exit code next to status "ok". Applies only to the
 * search commands in {@link SEARCH_COMMAND_NAMES}, not to `diff`, whose exit 1 means something
 * else (differences found) and is already unambiguous from its own output. */
export const NO_MATCHES_NOTE = 'No matches found. Exit code 1 is normal for this command and is not a failure.';

/**
 * Table of bare command names where exit 1 means "no matches" or
 * "differences found" and should be treated as status "ok" rather than
 * "exited". Applies only to a single simple command; a wrapped or piped
 * invocation of one of these never reaches this table (see module doc).
 */
const COMMAND_EXIT_CODE_SEMANTICS: Record<string, (exitCode: number) => boolean> = {
  grep: code => code === 1, // exit 1 means no matches
  egrep: code => code === 1,
  fgrep: code => code === 1,
  rg: code => code === 1, // ripgrep: exit 1 means no matches
  ag: code => code === 1, // The Silver Searcher: exit 1 means no matches
  'git grep': code => code === 1,
  diff: code => code === 1, // exit 1 means differences found
};

/** The subset of {@link COMMAND_EXIT_CODE_SEMANTICS} whose benign non-zero exit means "no
 * matches" rather than "differences found" - everything in the table except `diff`. */
const SEARCH_COMMAND_NAMES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'git grep']);

/**
 * Extract the command name a simple command's exit-code semantics should be
 * looked up under: the bare command name with any directory prefix
 * stripped (e.g. `/usr/bin/grep` -> `grep`), with one exception - `git
 * grep`, kept in the table as a literal two-word name pair when `grep` is
 * the command's very first argument. Any other form of `git`, or `grep`
 * behind git's own global options, does not match and falls through to a
 * plain `git` lookup (a miss).
 */
function extractCommandName(command: SimpleShellCommand): string {
  const commandName = command.name.split('/').pop() ?? command.name;
  if (commandName === 'git' && command.args[0] === 'grep') {
    return 'git grep';
  }
  return commandName;
}

/**
 * Classify a command's non-zero exit code as "ok" (exit 0 for any command, or a search/diff
 * command whose exit 1 is a benign "no matches"/"differences found" result) or "exited"
 * (anything else - a plain command not in the table, a pipeline, a list, a wrapper, a
 * substitution, a redirection, or an unparseable command - where the exit code cannot honestly
 * be called success). This never returns "failed": that status is reserved for the host's own
 * failures (could not start, killed by timeout, refused by policy), decided in
 * `buildExecResultShape` before a command's exit code is even considered.
 */
export function classifyExecStatus(command: string, exitCode: number): 'ok' | 'exited' {
  if (exitCode === 0) {
    return 'ok';
  }

  const simple = parseSimpleShellCommand(command.trim());
  if (!simple) {
    return 'exited';
  }

  const commandName = extractCommandName(simple);
  const semanticsFn = COMMAND_EXIT_CODE_SEMANTICS[commandName];
  return semanticsFn?.(exitCode) ? 'ok' : 'exited';
}

/**
 * True when `command` is a bare, single simple invocation of a grep-family search command (see
 * {@link SEARCH_COMMAND_NAMES}) whose exit code is that family's benign "no matches" code. Used
 * only to decide whether {@link NO_MATCHES_NOTE} applies - `classifyExecStatus` already folds
 * this same case into status "ok" on its own.
 */
function isSearchCommandNoMatches(command: string, exitCode: number): boolean {
  if (exitCode === 0) {
    return false;
  }
  const simple = parseSimpleShellCommand(command.trim());
  if (!simple) {
    return false;
  }
  const commandName = extractCommandName(simple);
  if (!SEARCH_COMMAND_NAMES.has(commandName)) {
    return false;
  }
  return COMMAND_EXIT_CODE_SEMANTICS[commandName]?.(exitCode) ?? false;
}

/**
 * Extract error summary from command output (first error line from stderr or stdout).
 * Returns the first non-empty line from the end of the output, or null if empty.
 */
export function extractErrorSummary(output: string): string | null {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  // Return the last non-empty line (most relevant error)
  return lines[lines.length - 1] ?? null;
}

/**
 * Build the model-facing exec result shape with honest status, exit code,
 * and error summary. A command that ran is "ok" or "exited" - see
 * `classifyExecStatus`. "failed" is reserved for a host failure that kept
 * the command from ever running (`sandboxSuccess` false): it could not be
 * started, was killed by the execution timeout, or was refused by policy.
 * An "exited" result never claims success; it carries a `note` explaining
 * why, on top of the same `exit_code` and `error_summary` an "ok" result
 * reports.
 */
export function buildExecResultShape(
  exitCode: number,
  command: string,
  output: string,
  sandboxSuccess: boolean,
): ExecResultShape {
  // If sandbox infrastructure failed, we couldn't run the command
  if (!sandboxSuccess) {
    return {
      status: 'failed',
      exit_code: -1,
      error_summary: output || 'Sandbox infrastructure failure',
      success: false,
      note: null,
    };
  }

  const status = classifyExecStatus(command, exitCode);
  const errorSummary = exitCode === 0 ? null : extractErrorSummary(output);
  const note = status === 'exited' ? EXITED_NOTE : isSearchCommandNoMatches(command, exitCode) ? NO_MATCHES_NOTE : null;

  return {
    status,
    exit_code: exitCode,
    error_summary: errorSummary,
    success: sandboxSuccess,
    note,
  };
}
