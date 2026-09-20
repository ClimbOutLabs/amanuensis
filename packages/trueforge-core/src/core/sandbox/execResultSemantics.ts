// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- bash-parser ships no types; the ambient declaration must be visible to every package that compiles this source, and a reference directive is the only form that follows the file.
/// <reference path="../../types/bash-parser.d.ts" />
import parseShell from 'bash-parser';
import type { CommandNode, CommandPart, WordExpansion, WordNode } from './bashParserTypes';

/**
 * Exit code semantics for sandbox commands.
 *
 * A command that ran has exactly two possible statuses:
 * - "ok": exit 0, or a non-zero exit from a single simple command (bash-parser resolves it to
 *   exactly one `Command` node with no pipeline, list, redirection, background execution, leading
 *   assignment, or substitution anywhere in its name or arguments) whose bare name - or, for
 *   `git grep`, the literal adjacent name pair - is in the search/diff table below.
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
 * The expansion types that make a word's runtime value depend on something
 * other than its literal text: a subprocess (command or process
 * substitution) or an arithmetic evaluation. Parameter expansions ($VAR,
 * ${VAR}) are excluded on purpose - substituting an environment variable
 * does not run anything and does not make the command's own exit status
 * unreliable. A parameter expansion's default/alternative value
 * (`${VAR:-...}` and friends) is itself a nested Word, though, and *that*
 * can carry a disqualifying expansion - so the check below recurses into it
 * rather than only looking at the top-level expansion list.
 */
const DISQUALIFYING_EXPANSION_TYPES = new Set(['CommandExpansion', 'ArithmeticExpansion', 'ProcessSubstitution']);

/**
 * True if none of the given expansions (nor anything nested inside a
 * parameter expansion's default/alternative word) is a command, process, or
 * arithmetic substitution.
 */
function isPlainExpansionList(expansions: WordExpansion[] | undefined): boolean {
  if (!expansions) {
    return true;
  }
  return expansions.every(expansion => {
    if (DISQUALIFYING_EXPANSION_TYPES.has(expansion.type)) {
      return false;
    }
    // A parameter expansion's default/alternative value (`${VAR:-word}`,
    // `${VAR:=word}`, etc.) is itself parsed as a Word and can nest a
    // command, process, or arithmetic substitution inside it.
    if (expansion.word && !isPlainExpansionList(expansion.word.expansion)) {
      return false;
    }
    return true;
  });
}

/**
 * A word is "plain" if it carries no expansion that could run a subprocess or
 * evaluate arithmetic, including nested inside a parameter expansion's
 * default value. Anything that is not a Word node at all (e.g. a Redirect,
 * or a raw here-doc operator token) is never plain.
 */
function isPlainWord(part: CommandPart | undefined): part is WordNode {
  if (part?.type !== 'Word') {
    return false;
  }
  return isPlainExpansionList((part as WordNode).expansion);
}

/**
 * True if the given node is a `Command` whose name and every argument are
 * plain Word nodes: no redirections, background execution, here-documents,
 * leading assignments, or command/process/arithmetic substitution anywhere
 * in the name or arguments.
 */
function isSimpleCommandNode(node: CommandNode | { type: string }): node is CommandNode {
  if (node.type !== 'Command') {
    return false;
  }
  const commandNode = node as CommandNode;
  if (commandNode.async) {
    return false; // backgrounded with `&`
  }
  if (commandNode.prefix && commandNode.prefix.length > 0) {
    return false; // leading redirect or variable assignment
  }
  if (!isPlainWord(commandNode.name)) {
    return false;
  }
  if (!(commandNode.suffix ?? []).every(isPlainWord)) {
    return false; // trailing redirect, or an argument with a disqualifying expansion
  }
  return true;
}

/**
 * If `command` parses to exactly one bash-parser `Command` node with no
 * pipeline, list, redirection, background execution, leading assignment, or
 * substitution anywhere in it, return that node. Otherwise (a pipeline, a
 * list via `;`/`&&`/`||`, a subshell, a here-document, or a command the
 * parser can't make sense of) return null: none of those get an "ok"
 * verdict, only "exited".
 */
function asSingleSimpleCommand(command: string): CommandNode | null {
  let script;
  try {
    script = parseShell(command);
  } catch {
    return null;
  }

  if (script.commands.length !== 1) {
    return null; // sequential list, e.g. via `;` or a newline (includes here-docs)
  }

  const node = script.commands[0];
  if (!node) {
    return null;
  }

  return isSimpleCommandNode(node) ? node : null;
}

/**
 * Extract the command name a simple command's exit-code semantics should be
 * looked up under: the bare command name with any directory prefix
 * stripped (e.g. `/usr/bin/grep` -> `grep`), with one exception - `git
 * grep`, kept in the table as a literal two-word name pair when `grep` is
 * the command's very first argument. Any other form of `git`, or `grep`
 * behind git's own global options, does not match and falls through to a
 * plain `git` lookup (a miss).
 */
function extractCommandName(node: CommandNode): string {
  const firstWord = node.name.text;
  const commandName = firstWord.split('/').pop() ?? firstWord;
  if (commandName === 'git') {
    const firstArg = (node.suffix ?? [])[0];
    if (firstArg?.type === 'Word' && (firstArg as WordNode).text === 'grep') {
      return 'git grep';
    }
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

  const node = asSingleSimpleCommand(command.trim());
  if (!node) {
    return 'exited';
  }

  const commandName = extractCommandName(node);
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
  const node = asSingleSimpleCommand(command.trim());
  if (!node) {
    return false;
  }
  const commandName = extractCommandName(node);
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
