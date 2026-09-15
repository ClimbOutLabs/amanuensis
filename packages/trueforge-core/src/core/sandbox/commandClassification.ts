/**
 * Effects used by the sandbox admission check. Unknown commands remain
 * `execute`, which is deliberately approval-gated.
 */
export type SandboxCommandEffect = 'inspect' | 'edit' | 'verify' | 'commit' | 'push' | 'execute';

export const SANDBOX_INVOCATION_PURPOSES = ['inspect', 'edit', 'verify', 'execute', 'commit', 'push'] as const;
export type SandboxInvocationPurpose = (typeof SANDBOX_INVOCATION_PURPOSES)[number];
type SandboxCommandSafetyEffect = Exclude<SandboxCommandEffect, 'verify'>;

export interface SandboxInvocationPolicy {
  effect: SandboxCommandEffect;
  rejection: string | undefined;
}

const INSPECT_COMMANDS = new Set([
  'basename',
  'cat',
  'cut',
  'df',
  'dirname',
  'du',
  'echo',
  'file',
  'grep',
  'git',
  'head',
  'ls',
  'md5sum',
  'pwd',
  'realpath',
  'readlink',
  'rg',
  'sha256sum',
  'sort',
  'stat',
  'tail',
  'tree',
  'true',
  'uniq',
  'wc',
  'which',
]);

const EDIT_COMMANDS = new Set([
  'chmod',
  'chown',
  'cp',
  'dd',
  'install',
  'ln',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'rmdir',
  'tee',
  'touch',
  'truncate',
]);

const GIT_INSPECT_COMMANDS = new Set([
  'diff',
  'describe',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'shortlog',
  'status',
]);

const GIT_EDIT_COMMANDS = new Set([
  'add',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'config',
  'fetch',
  'init',
  'merge',
  'pull',
  'rebase',
  'restore',
  'reset',
  'stash',
  'switch',
  'tag',
]);

const GIT_REPOSITORY_SETUP_COMMANDS = new Set(['checkout', 'clone', 'config', 'fetch', 'init', 'switch', 'worktree']);

interface TokenizedCommand {
  tokens: string[];
  unsafe: boolean;
}

/** Discard-only redirects do not mutate the repository. */
function stripNullDeviceRedirects(command: string): string {
  return command.replace(/(?:^|\s)\d*>>?\/dev\/null(?=\s|$)/g, ' ');
}

/**
 * File-descriptor duplication (`2>&1`, `>&2`) or closing (`2>&-`, `>&-`)
 * writes nothing to the filesystem; it only points one already-open
 * descriptor at another (or closes it). Models emit `2>&1` constantly even
 * though stderr is already captured by the exec tool, so treat it like a
 * discard redirect regardless of what shell punctuation follows it (`;`,
 * `&&`, `|`, `)`, or end of string) -- unlike a null-device redirect there
 * is no meaningful "target" to require whitespace around.
 *
 * `&>word` is NOT an alternate spelling of descriptor duplication: bash
 * defines `&>word` as "redirect both streams to the file named `word`"
 * unconditionally, even when `word` is numeric or `-` (`&>1` truncates a
 * file named `1`). Only the `[n]>&word` form duplicates when `word` is
 * exactly digits or `-`, so `&>` is never stripped here.
 *
 * `>&word` where `word` is not *exactly* digits or `-` is also bash's
 * "redirect both streams to a file" form and must stay refused. The operand
 * has to end at a real shell-token boundary -- end of string, whitespace,
 * `;`, `|`, `&`, `)`, or newline -- not merely "not alphanumeric/filename
 * punctuation", or targets like `1:log` / `1abc` (whose leading digits look
 * like a valid operand but whose full word is not) would slip through
 * (e.g. `>&1file`, `2>&12abc`, `>&1:log`). The leading lookbehind still
 * keeps the match from firing inside a larger identifier or filename (e.g.
 * `file2>&1`).
 */
function stripFileDescriptorMerges(command: string): string {
  return command.replace(/(?<![0-9A-Za-z_])\d*>&(?:\d+|-)(?=$|[\s;|&)])/g, ' ');
}

function commandForTokenizing(command: string): string {
  return stripFileDescriptorMerges(stripNullDeviceRedirects(command));
}

function tokenize(command: string): TokenizedCommand[] {
  const commands: TokenizedCommand[] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let unsafe = false;

  const finishToken = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = '';
    }
  };
  const finishCommand = () => {
    finishToken();
    if (tokens.length > 0 || unsafe) {
      commands.push({ tokens, unsafe });
    }
    tokens = [];
    unsafe = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) {
      break;
    }
    const next = command[index + 1];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (quote === '"' && (character === '`' || (character === '$' && next === '('))) {
        unsafe = true;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '`' || (character === '$' && next === '(')) {
      unsafe = true;
      continue;
    }
    if (character === '>' || character === '<') {
      finishToken();
      unsafe = true;
      continue;
    }
    if (character === ';' || character === '|') {
      finishCommand();
      if (character === '|' && next === '|') {
        index += 1;
      }
      continue;
    }
    if (character === '&') {
      finishCommand();
      if (next === '&') {
        index += 1;
      } else {
        unsafe = true;
      }
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
  }

  if (quote !== undefined || escaped) {
    unsafe = true;
  }
  finishCommand();
  return commands;
}

function commandName(tokens: string[]): string {
  return tokens[0]?.split('/').pop()?.toLowerCase() ?? '';
}

const DIRECT_SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const ENVIRONMENT_WRAPPER_DEPTH_LIMIT = 4;
const ENVIRONMENT_SPLIT_DEPTH_LIMIT = 4;
const INDIRECT_COMMAND_DEPTH_LIMIT = 4;
const ENV_SHORT_OPTIONS = new Set(['0', 'a', 'C', 'i', 'S', 'u', 'v']);
const ENV_SHORT_OPTIONS_WITH_VALUE = new Set(['a', 'C', 'S', 'u']);

type EnvironmentOptionValue = 'none' | 'optional' | 'required';

interface EnvironmentLongOption {
  name: string;
  value: EnvironmentOptionValue;
  splitString: boolean;
  terminating: boolean;
}

const ENV_LONG_OPTIONS: EnvironmentLongOption[] = [
  { name: 'argv0', value: 'required', splitString: false, terminating: false },
  { name: 'block-signal', value: 'optional', splitString: false, terminating: false },
  { name: 'chdir', value: 'required', splitString: false, terminating: false },
  { name: 'debug', value: 'none', splitString: false, terminating: false },
  { name: 'default-signal', value: 'optional', splitString: false, terminating: false },
  { name: 'help', value: 'none', splitString: false, terminating: true },
  { name: 'ignore-environment', value: 'none', splitString: false, terminating: false },
  { name: 'ignore-signal', value: 'optional', splitString: false, terminating: false },
  { name: 'list-signal-handling', value: 'none', splitString: false, terminating: false },
  { name: 'null', value: 'none', splitString: false, terminating: false },
  { name: 'split-string', value: 'required', splitString: true, terminating: false },
  { name: 'unset', value: 'required', splitString: false, terminating: false },
  { name: 'version', value: 'none', splitString: false, terminating: true },
];

interface EnvironmentPrefix {
  commandTokens: string[];
  isEnvironment: boolean;
  unsafe: boolean;
}

interface EnvironmentSplitResult {
  tokens: string[];
  unsafe: boolean;
}

interface ResolvedEnvironmentCommand {
  commandTokens: string[];
  hadEnvironmentPrefix: boolean;
  unsafe: boolean;
}

function environmentLongOption(name: string): EnvironmentLongOption | undefined {
  const matches = ENV_LONG_OPTIONS.filter(option => option.name.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Split the bounded, non-expanding subset of GNU `env -S` syntax used for command admission. */
function splitEnvironmentString(value: string): EnvironmentSplitResult {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const finishToken = () => {
    if (tokenStarted) {
      tokens.push(token);
      token = '';
      tokenStarted = false;
    }
  };

  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (character === '\\' || (quote === '"' && character === '$')) {
        return { tokens: [], unsafe: true };
      }
      token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/[ \t\n\r\v\f]/u.test(character)) {
      finishToken();
      continue;
    }
    if (character === '\\' || character === '$' || (character === '#' && !tokenStarted)) {
      return { tokens: [], unsafe: true };
    }
    token += character;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    return { tokens: [], unsafe: true };
  }
  finishToken();
  return { tokens, unsafe: false };
}

/** Parse direct assignments and the option-consuming portion of an `env` wrapper. */
function parseEnvironmentPrefix(tokens: string[]): EnvironmentPrefix | undefined {
  let index = 0;
  while (DIRECT_SHELL_ASSIGNMENT.test(tokens[index] ?? '')) {
    index += 1;
  }
  const usesEnv = commandName(tokens.slice(index)) === 'env';
  if (!usesEnv) {
    return index === 0 ? undefined : { commandTokens: tokens.slice(index), isEnvironment: false, unsafe: false };
  }

  let argumentsTokens = tokens.slice(index + 1);
  index = 0;
  let splitDepth = 0;
  while (index < argumentsTokens.length) {
    const option = argumentsTokens[index];
    if (option === '--') {
      index += 1;
      break;
    }
    if (option === '-') {
      index += 1;
      continue;
    }
    if (option?.startsWith('-') !== true) {
      break;
    }
    if (option.startsWith('--')) {
      const equalsIndex = option.indexOf('=');
      const optionName = option.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
      const longOption = environmentLongOption(optionName);
      if (longOption === undefined) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      const hasAttachedValue = equalsIndex >= 0;
      if (longOption.value === 'none' && hasAttachedValue) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      if (longOption.terminating) {
        return { commandTokens: [], isEnvironment: true, unsafe: false };
      }
      let nextIndex = index + 1;
      let optionValue: string | undefined;
      if (longOption.value === 'required') {
        optionValue = hasAttachedValue ? option.slice(equalsIndex + 1) : argumentsTokens[index + 1];
        if (optionValue === undefined) {
          return { commandTokens: [], isEnvironment: true, unsafe: true };
        }
        nextIndex += hasAttachedValue ? 0 : 1;
      }
      if (longOption.splitString) {
        splitDepth += 1;
        if (splitDepth > ENVIRONMENT_SPLIT_DEPTH_LIMIT || optionValue === undefined) {
          return { commandTokens: [], isEnvironment: true, unsafe: true };
        }
        const split = splitEnvironmentString(optionValue);
        if (split.unsafe) {
          return { commandTokens: [], isEnvironment: true, unsafe: true };
        }
        argumentsTokens = [...split.tokens, ...argumentsTokens.slice(nextIndex)];
        index = 0;
        continue;
      }
      index = nextIndex;
      continue;
    }

    const shortOptions = option.slice(1);
    let consumedValue = false;
    let nextIndex = index + 1;
    let splitStringValue: string | undefined;
    for (let optionIndex = 0; optionIndex < shortOptions.length; optionIndex += 1) {
      const shortOption = shortOptions[optionIndex];
      if (shortOption === undefined || !ENV_SHORT_OPTIONS.has(shortOption)) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      if (!ENV_SHORT_OPTIONS_WITH_VALUE.has(shortOption)) {
        continue;
      }
      const attachedValue = shortOptions.slice(optionIndex + 1);
      const optionValue = attachedValue.length > 0 ? attachedValue : argumentsTokens[index + 1];
      if (optionValue === undefined) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      nextIndex += attachedValue.length > 0 ? 0 : 1;
      if (shortOption === 'S') {
        splitStringValue = optionValue;
      }
      consumedValue = true;
      break;
    }
    if (splitStringValue !== undefined) {
      splitDepth += 1;
      if (splitDepth > ENVIRONMENT_SPLIT_DEPTH_LIMIT) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      const split = splitEnvironmentString(splitStringValue);
      if (split.unsafe) {
        return { commandTokens: [], isEnvironment: true, unsafe: true };
      }
      argumentsTokens = [...split.tokens, ...argumentsTokens.slice(nextIndex)];
      index = 0;
      continue;
    }
    index = consumedValue ? nextIndex : index + 1;
  }
  while ((argumentsTokens[index] ?? '').includes('=')) {
    index += 1;
  }
  return { commandTokens: argumentsTokens.slice(index), isEnvironment: true, unsafe: false };
}

function resolveEnvironmentCommand(tokens: string[]): ResolvedEnvironmentCommand {
  let commandTokens = tokens;
  let environmentDepth = 0;
  let hadEnvironmentPrefix = false;
  while (commandTokens.length > 0) {
    const prefix = parseEnvironmentPrefix(commandTokens);
    if (prefix === undefined) {
      return { commandTokens, hadEnvironmentPrefix, unsafe: false };
    }
    hadEnvironmentPrefix = true;
    if (prefix.unsafe) {
      return { commandTokens: [], hadEnvironmentPrefix, unsafe: true };
    }
    if (prefix.isEnvironment) {
      environmentDepth += 1;
      if (environmentDepth > ENVIRONMENT_WRAPPER_DEPTH_LIMIT) {
        return { commandTokens: [], hadEnvironmentPrefix, unsafe: true };
      }
    }
    commandTokens = prefix.commandTokens;
  }
  return { commandTokens, hadEnvironmentPrefix, unsafe: false };
}

const EVALUATOR_WRAPPERS = new Set(['eval', 'exec', 'command', 'sudo', 'doas']);
const SHELL_EVALUATORS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish']);
const POWERSHELL_EVALUATORS = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);
const PYTHON_EXECUTABLE = /^(?:py|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/u;
const PYTHON_TERMINATING_OPTIONS = new Set([
  '-?',
  '-V',
  '-VV',
  '-h',
  '--help',
  '--help-all',
  '--help-env',
  '--help-xoptions',
  '--version',
]);
const XARGS_OPTIONS_WITH_VALUE = new Set([
  '-a',
  '--arg-file',
  '-d',
  '--delimiter',
  '-E',
  '-I',
  '-L',
  '-n',
  '--max-args',
  '-P',
  '--max-procs',
  '-s',
  '--max-chars',
  '--process-slot-var',
]);
const XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUE = new Set(['--eof', '--max-lines', '--replace']);
const XARGS_LONG_OPTIONS_WITHOUT_VALUE = new Set([
  '--exit',
  '--help',
  '--interactive',
  '--no-run-if-empty',
  '--null',
  '--open-tty',
  '--show-limits',
  '--verbose',
  '--version',
]);

interface ExecutionWrapperSpec {
  optionsWithValue: ReadonlySet<string>;
  optionsWithoutValue: ReadonlySet<string>;
  terminatingOptions: ReadonlySet<string>;
  positionalArgumentsBeforeCommand: number;
}

const EXECUTION_WRAPPER_SPECS = new Map<string, ExecutionWrapperSpec>([
  [
    'timeout',
    {
      optionsWithValue: new Set(['-k', '--kill-after', '-s', '--signal']),
      optionsWithoutValue: new Set(['-f', '--foreground', '-p', '--preserve-status', '-v', '--verbose']),
      terminatingOptions: new Set(['--help', '--version']),
      positionalArgumentsBeforeCommand: 1,
    },
  ],
  [
    'nice',
    {
      optionsWithValue: new Set(['-n', '--adjustment']),
      optionsWithoutValue: new Set<string>(),
      terminatingOptions: new Set(['--help', '--version']),
      positionalArgumentsBeforeCommand: 0,
    },
  ],
  [
    'nohup',
    {
      optionsWithValue: new Set<string>(),
      optionsWithoutValue: new Set<string>(),
      terminatingOptions: new Set(['--help', '--version']),
      positionalArgumentsBeforeCommand: 0,
    },
  ],
  [
    'setsid',
    {
      optionsWithValue: new Set<string>(),
      optionsWithoutValue: new Set(['-c', '--ctty', '-f', '--fork', '-w', '--wait']),
      terminatingOptions: new Set(['--help', '--version']),
      positionalArgumentsBeforeCommand: 0,
    },
  ],
]);

function isPythonExecutable(token: string | undefined): boolean {
  const tokenName = token?.split(/[\\/]/u).pop()?.toLowerCase() ?? '';
  return PYTHON_EXECUTABLE.test(tokenName);
}

function hasInlinePythonCodeArgument(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--' || token?.startsWith('-') !== true) {
      return false;
    }
    if (token === '-c' || /^-c.+/u.test(token)) {
      return true;
    }
    if (token === '-m' || /^-m.+/u.test(token)) {
      return false;
    }
    if (token === '-W' || token === '-X' || token === '--check-hash-based-pycs') {
      index += 1;
    }
  }
  return false;
}

function xargsCommandTokens(tokens: string[]): string[] | undefined {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      return tokens.slice(index + 1);
    }
    if (token?.startsWith('-') !== true) {
      return tokens.slice(index);
    }
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const optionName = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
      if (XARGS_OPTIONS_WITH_VALUE.has(optionName)) {
        index += equalsIndex < 0 ? 2 : 1;
        continue;
      }
      if (
        XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUE.has(optionName) ||
        (XARGS_LONG_OPTIONS_WITHOUT_VALUE.has(optionName) && equalsIndex < 0)
      ) {
        index += 1;
        continue;
      }
      return undefined;
    }
    index += 1;
    if (XARGS_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
    }
  }
  return undefined;
}

function executionWrapperCommandTokens(tokens: string[], spec: ExecutionWrapperSpec): string[] | undefined {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token?.startsWith('-') !== true || token === '-') {
      break;
    }

    let optionName = token;
    let hasAttachedValue = false;
    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      optionName = token.slice(0, equalsIndex);
      hasAttachedValue = true;
    } else if (!token.startsWith('--') && token.length > 2) {
      const shortOptionName = token.slice(0, 2);
      if (spec.optionsWithValue.has(shortOptionName)) {
        optionName = shortOptionName;
        hasAttachedValue = true;
      } else if (/^-\d+$/u.test(token) && commandName(tokens) === 'nice') {
        index += 1;
        continue;
      }
    }

    if (spec.terminatingOptions.has(optionName)) {
      return [];
    }
    if (spec.optionsWithoutValue.has(optionName)) {
      if (hasAttachedValue) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (spec.optionsWithValue.has(optionName)) {
      if (!hasAttachedValue && tokens[index + 1] === undefined) {
        return undefined;
      }
      index += hasAttachedValue ? 1 : 2;
      continue;
    }
    return undefined;
  }

  index += spec.positionalArgumentsBeforeCommand;
  if (tokens[index] === '--') {
    index += 1;
  }
  return tokens.slice(index);
}

function nestedCommandTokens(tokens: string[]): string[][] | undefined {
  const name = commandName(tokens);
  const executionWrapperSpec = EXECUTION_WRAPPER_SPECS.get(name);
  if (executionWrapperSpec !== undefined) {
    const nested = executionWrapperCommandTokens(tokens, executionWrapperSpec);
    return nested === undefined ? undefined : nested.length === 0 ? [] : [nested];
  }
  if (name === 'xargs') {
    const nested = xargsCommandTokens(tokens);
    return nested === undefined || nested.length === 0 ? undefined : [nested];
  }
  if (name !== 'find') {
    return [];
  }

  const commands: string[][] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase();
    if (token !== '-exec' && token !== '-execdir' && token !== '-ok' && token !== '-okdir') {
      continue;
    }
    const end = tokens.findIndex(
      (candidate, candidateIndex) => candidateIndex > index && (candidate === ';' || candidate === '+'),
    );
    if (end < 0 || end === index + 1) {
      return undefined;
    }
    commands.push(tokens.slice(index + 1, end));
    index = end;
  }
  return commands;
}

function hasNestedCommandSyntax(tokens: string[]): boolean {
  return (
    EXECUTION_WRAPPER_SPECS.has(commandName(tokens)) ||
    commandName(tokens) === 'xargs' ||
    (commandName(tokens) === 'find' &&
      tokens.some(token => ['-exec', '-execdir', '-ok', '-okdir'].includes(token.toLowerCase())))
  );
}

function nextIndirectDepth(depth: number): number | undefined {
  return depth < INDIRECT_COMMAND_DEPTH_LIMIT ? depth + 1 : undefined;
}

function commandInvokesInlinePython(tokens: string[], depth = 0): boolean {
  const resolved = resolveEnvironmentCommand(tokens);
  if (resolved.unsafe) {
    return true;
  }
  const commandTokens = resolved.commandTokens;
  if (isPythonExecutable(commandTokens[0])) {
    return hasInlinePythonCodeArgument(commandTokens.slice(1));
  }
  const nested = nestedCommandTokens(commandTokens);
  if (nested === undefined) {
    return hasNestedCommandSyntax(commandTokens);
  }
  if (nested.length > 0) {
    const nextDepth = nextIndirectDepth(depth);
    return nextDepth === undefined || nested.some(candidate => commandInvokesInlinePython(candidate, nextDepth));
  }
  return false;
}

function commandInvokesPythonFromStdin(tokens: string[], depth = 0): boolean {
  const resolved = resolveEnvironmentCommand(tokens);
  if (resolved.unsafe) {
    return true;
  }
  const commandTokens = resolved.commandTokens;
  if (isPythonExecutable(commandTokens[0])) {
    for (let index = 1; index < commandTokens.length; index += 1) {
      const token = commandTokens[index];
      if (token !== undefined && PYTHON_TERMINATING_OPTIONS.has(token)) {
        return false;
      }
      if (token === '-') {
        return true;
      }
      if (token === '--') {
        return commandTokens[index + 1] === undefined || commandTokens[index + 1] === '-';
      }
      if (token?.startsWith('-') !== true) {
        return false;
      }
      if (token === '-c' || /^-c.+/u.test(token) || token === '-m' || /^-m.+/u.test(token)) {
        return false;
      }
      if (token === '-W' || token === '-X' || token === '--check-hash-based-pycs') {
        index += 1;
      }
    }
    return true;
  }
  const nested = nestedCommandTokens(commandTokens);
  if (nested === undefined) {
    return hasNestedCommandSyntax(commandTokens);
  }
  if (nested.length > 0) {
    const nextDepth = nextIndirectDepth(depth);
    return nextDepth === undefined || nested.some(candidate => commandInvokesPythonFromStdin(candidate, nextDepth));
  }
  return false;
}

/**
 * Reject indirection that hides the command admission class. The sandbox
 * already executes through a shell, so nested evaluators are unnecessary and
 * would let consequential operations evade commit/push separation.
 */
export function sandboxCommandUsesEvaluatorWrapper(command: string): boolean {
  const commandStartsEvaluatorWrapper = (commandTokens: string[]): boolean => {
    const first = commandName(commandTokens);
    if (EVALUATOR_WRAPPERS.has(first) && !(first === 'command' && commandTokens[1] === '-v')) {
      return true;
    }
    const argumentsTokens = commandTokens.slice(1).map(token => token.toLowerCase());
    if (
      SHELL_EVALUATORS.has(first) &&
      argumentsTokens.some(token => token.startsWith('-c') || token.startsWith('--command'))
    ) {
      return true;
    }
    if (
      POWERSHELL_EVALUATORS.has(first) &&
      argumentsTokens.some(token =>
        ['-command', '-commandwithargs', '-encodedcommand', '-encodedarguments'].some(option =>
          option.startsWith(token),
        ),
      )
    ) {
      return true;
    }
    return first === 'cmd' && argumentsTokens.some(token => token === '/c' || token === '/k');
  };

  const commandUsesEvaluatorWrapper = (tokens: string[], depth = 0): boolean => {
    const resolved = resolveEnvironmentCommand(tokens);
    if (resolved.unsafe) {
      return true;
    }
    const commandTokens = resolved.commandTokens;
    if (commandStartsEvaluatorWrapper(commandTokens)) {
      return true;
    }
    const nested = nestedCommandTokens(commandTokens);
    if (nested === undefined) {
      return hasNestedCommandSyntax(commandTokens);
    }
    if (nested.length > 0) {
      const nextDepth = nextIndirectDepth(depth);
      return nextDepth === undefined || nested.some(candidate => commandUsesEvaluatorWrapper(candidate, nextDepth));
    }
    if (singleCommandEffect({ tokens: commandTokens, unsafe: false }) === 'inspect') {
      return false;
    }
    // An unknown executable may itself launch the command represented by its
    // remaining arguments. Fail closed when those arguments contain an
    // evaluator signature; otherwise commit/push could be approved merely as
    // a generic execute call through an unrecognised launcher.
    return commandTokens.slice(1).some((_, index) => commandStartsEvaluatorWrapper(commandTokens.slice(index + 1)));
  };
  return tokenize(commandForTokenizing(command)).some(candidate => commandUsesEvaluatorWrapper(candidate.tokens));
}

function commandUsesUnstructuredOperation(tokens: string[]): boolean {
  const resolved = resolveEnvironmentCommand(tokens);
  if (resolved.unsafe) {
    return true;
  }
  const commandTokens = resolved.commandTokens;
  const name = commandName(commandTokens);
  if (name === 'tee') {
    return true;
  }
  return commandInvokesInlinePython(commandTokens) || commandInvokesPythonFromStdin(commandTokens);
}

/** Reject shell-backed writes and opaque Python evaluators from structured admission. */
export function sandboxCommandUsesUnstructuredOperation(command: string): boolean {
  const commandWithoutDiscardRedirects = commandForTokenizing(command);
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < commandWithoutDiscardRedirects.length; index += 1) {
    const character = commandWithoutDiscardRedirects[index];
    const next = commandWithoutDiscardRedirects[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '>' || (character === '<' && next === '<')) {
      return true;
    }
  }
  return tokenize(commandForTokenizing(command)).some(
    candidate => candidate.unsafe || commandUsesUnstructuredOperation(candidate.tokens),
  );
}

function hasUnquotedPipeOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '|') {
      return true;
    }
  }
  return false;
}

function parseGitCommand(tokens: string[]): { subcommand: string | undefined; hasConfigOverride: boolean } {
  let hasConfigOverride = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const rawToken = tokens[index];
    if (rawToken === '-C') {
      index += 1;
      continue;
    }
    const token = rawToken?.toLowerCase();
    if (token === '-c') {
      hasConfigOverride = true;
      index += 1;
      continue;
    }
    if (token !== undefined && !token.startsWith('-')) {
      return { subcommand: token, hasConfigOverride };
    }
  }
  return { subcommand: undefined, hasConfigOverride };
}

function gitEffect(tokens: string[]): SandboxCommandSafetyEffect {
  const { subcommand, hasConfigOverride } = parseGitCommand(tokens);
  // Commit and push remain consequential even when invoked with a config override.
  if (subcommand === 'commit') {
    return 'commit';
  }
  if (subcommand === 'push') {
    return 'push';
  }
  // Other `git -c key=value ...` calls can change helpers, pagers, and transports.
  if (hasConfigOverride) {
    return 'execute';
  }
  if (
    subcommand !== undefined &&
    GIT_INSPECT_COMMANDS.has(subcommand) &&
    !tokens.some(token => token === '--output' || token.startsWith('--output=')) &&
    !tokens.some(token => token === '--open-files-in-pager' || token.startsWith('--open-files-in-pager='))
  ) {
    return 'inspect';
  }
  if (subcommand !== undefined && GIT_EDIT_COMMANDS.has(subcommand)) {
    return 'edit';
  }
  return 'execute';
}

export function sandboxCommandHasGitSubcommand(command: string, subcommand: 'commit' | 'push'): boolean {
  const commandHasGitSubcommand = (tokens: string[], depth = 0): boolean => {
    const resolved = resolveEnvironmentCommand(tokens);
    if (resolved.unsafe) {
      return false;
    }
    if (commandName(resolved.commandTokens) === 'git') {
      return parseGitCommand(resolved.commandTokens).subcommand === subcommand;
    }
    const nested = nestedCommandTokens(resolved.commandTokens);
    const nextDepth = nextIndirectDepth(depth);
    return (
      nested !== undefined && nextDepth !== undefined && nested.some(item => commandHasGitSubcommand(item, nextDepth))
    );
  };
  return tokenize(commandForTokenizing(command)).some(candidate => {
    if (candidate.unsafe) {
      return false;
    }
    return commandHasGitSubcommand(candidate.tokens);
  });
}

/**
 * Standalone client binaries whose entire purpose is an outbound network
 * connection. Deliberately narrow: this flags an approval-card risk signal
 * (open_world_hint), never the admission effect, so a false negative here
 * still leaves the command gated by its ordinary syntax classification
 * (a script invocation like `python send_email.py` is already `execute`,
 * approval-gated, before this check ever runs).
 */
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'sftp', 'ssh', 'scp']);

/**
 * Whether the command's syntax names a known network client, including
 * through the same wrapper indirection (`env`, `timeout`, `nice`, `nohup`,
 * `setsid`, `xargs`, `find -exec`) the effect classifier already unwraps.
 * A host-owned, syntax-only signal: it augments the approval prompt with
 * `open_world_hint` but never widens or narrows `is_approval_required`.
 * Absence is never read as an assurance that the command stays local — a
 * script invoked by name (`python send_email.py`) can still reach the
 * network from code this classifier cannot see.
 *
 * Unlike the effect classifiers, an unsafe candidate is not discarded here.
 * The effect classifiers treat an unclassifiable candidate conservatively as
 * `execute` (approval-gated); for this additive advisory the conservative
 * direction is the opposite — still flag when the executable is unambiguously
 * a network client. Redirection (`curl URL > out.json`) marks the candidate
 * unsafe while keeping its command tokens, and the leading executable is
 * unchanged. `commandUsesNetworkTool` only matches when the resolved command
 * name is a network binary, so a redirect *target* named like one is not
 * treated as the command.
 */
export function sandboxCommandHasNetworkIntent(command: string): boolean {
  const commandUsesNetworkTool = (tokens: string[], depth = 0): boolean => {
    const resolved = resolveEnvironmentCommand(tokens);
    if (resolved.unsafe) {
      return false;
    }
    if (NETWORK_COMMANDS.has(commandName(resolved.commandTokens))) {
      return true;
    }
    const nested = nestedCommandTokens(resolved.commandTokens);
    const nextDepth = nextIndirectDepth(depth);
    return (
      nested !== undefined && nextDepth !== undefined && nested.some(item => commandUsesNetworkTool(item, nextDepth))
    );
  };
  return tokenize(commandForTokenizing(command)).some(candidate => commandUsesNetworkTool(candidate.tokens));
}

/** Loopback hosts a network client can still reach even when a web connector is configured. */
const LOCAL_NETWORK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isLocalNetworkHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_NETWORK_HOSTS.has(normalized) || normalized.endsWith('.localhost');
}

/**
 * Options each supported network client accepts as a separate following token (`-p 22`,
 * `--connect-timeout 5`) rather than a self-contained flag. Skipping only tokens that start with
 * `-` would otherwise leave the *value* of one of these options as the next token examined, and
 * that value (a port number, a timeout, a header) can itself look host-shaped to `new URL()`.
 * Deliberately not exhaustive of every client flag: entries the model still supplies unlisted
 * (a rare, less common option) are already handled conservatively, since a token that fails to
 * parse as a URL is simply skipped rather than misread as a host.
 */
const NETWORK_TOOL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  curl: new Set([
    '-A',
    '--user-agent',
    '-b',
    '--cookie',
    '-c',
    '--cookie-jar',
    '-d',
    '--data',
    '--data-raw',
    '--data-binary',
    '--data-urlencode',
    '--data-ascii',
    '-e',
    '--referer',
    '-F',
    '--form',
    '-H',
    '--header',
    '-o',
    '--output',
    '-r',
    '--range',
    '-T',
    '--upload-file',
    '-u',
    '--user',
    '-X',
    '--request',
    '-x',
    '--proxy',
    '-w',
    '--write-out',
    '-K',
    '--config',
    '-m',
    '--max-time',
    '--connect-timeout',
    '--retry',
    '--retry-delay',
    '--retry-max-time',
    '--cacert',
    '--cert',
    '--key',
    '--resolve',
    '--interface',
    '--limit-rate',
  ]),
  wget: new Set([
    '-O',
    '--output-document',
    '-o',
    '--output-file',
    '-P',
    '--directory-prefix',
    '-T',
    '--timeout',
    '--connect-timeout',
    '--read-timeout',
    '--dns-timeout',
    '-t',
    '--tries',
    '-U',
    '--user-agent',
    '--header',
    '--user',
    '--password',
    '--bind-address',
  ]),
  ssh: new Set([
    '-p',
    '-i',
    '-l',
    '-o',
    '-F',
    '-b',
    '-c',
    '-D',
    '-E',
    '-I',
    '-J',
    '-L',
    '-m',
    '-O',
    '-Q',
    '-R',
    '-S',
    '-w',
    '-W',
  ]),
  scp: new Set(['-P', '-i', '-l', '-o', '-F', '-c', '-J', '-S']),
  sftp: new Set(['-P', '-i', '-o', '-F', '-c', '-D', '-J', '-R', '-S', '-b']),
  nc: new Set(['-p', '-s', '-w', '-i', '-q']),
  ncat: new Set(['-p', '-s', '-w', '-i', '-q', '-o', '-g', '-G']),
  netcat: new Set(['-p', '-s', '-w', '-i', '-q']),
  telnet: new Set(['-l', '-e']),
  ftp: new Set(['-o']),
};

/**
 * Options whose values are network destinations (proxies, jump hosts, forwarding specs)
 * rather than arbitrary parameters. These values must be examined for external hosts,
 * not blindly skipped as ordinary option arguments.
 */
const NETWORK_TOOL_DESTINATION_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  curl: new Set([
    '-x', // proxy: value is http://proxy.example[:port]
    '--proxy',
  ]),
  ssh: new Set([
    '-J', // jump: value is [user@]host[:port]
    '--jump',
  ]),
  scp: new Set(['-J']),
  sftp: new Set(['-J']),
};

/**
 * Check if a token looks like it could be a remote destination (for SCP/SFTP).
 * Remote destinations contain @ or : not at the start (like user@host:path or host:path),
 * or are plain hostnames that don't look like local filesystem paths.
 * Local paths (absolute, relative, or relative to current directory) are excluded.
 */
function looksLikeRemoteDestination(token: string): boolean {
  // Absolute or relative local filesystem paths are not remote destinations
  if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) {
    return false;
  }
  // Contains user indicator
  if (token.includes('@')) {
    return true;
  }
  // Contains : but not at the start (host:path format, not :file)
  const colonIndex = token.indexOf(':');
  if (colonIndex > 0) {
    return true;
  }
  // Contains path separators: it's a local path
  if (token.includes('/') || token.includes('\\')) {
    return false;
  }
  // Plain tokens without path separators: distinguish between filenames and hostnames
  // If it looks like a simple filename (ends with common filename extensions and no dots elsewhere,
  // or is a single word), treat as local. Otherwise, treat as remote (hostname/IP).

  // Common filename extensions
  const commonExtensions = [
    '.txt',
    '.log',
    '.json',
    '.csv',
    '.xml',
    '.sql',
    '.py',
    '.js',
    '.ts',
    '.go',
    '.rs',
    '.rb',
    '.sh',
    '.bash',
    '.bat',
    '.exe',
    '.tar',
    '.gz',
    '.zip',
    '.bin',
    '.so',
    '.dll',
    '.o',
    '.a',
    '.jar',
  ];
  for (const ext of commonExtensions) {
    if (token.toLowerCase().endsWith(ext)) {
      return false;
    }
  }

  // If it looks like an IP address (all digits and dots), it's remote
  if (/^\d+(\.\d+)*$/.test(token)) {
    return true;
  }

  // Otherwise, assume it's a hostname (e.g., 'localhost', 'example.com', 'host-1')
  return true;
}

/**
 * Extract a host from a destination-bearing option value. For most options,
 * the value is a direct URL or user@host format; for complex specs like
 * SSH -L port:host:port, we extract only the remote host.
 */
function extractHostFromDestinationOption(optionName: string, value: string): string | undefined {
  if (optionName === '-x' || optionName === '--proxy') {
    // curl proxy: http://proxy.example[:port]
    try {
      const url = new URL(value);
      return url.hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (optionName === '-J' || optionName === '--jump') {
    // SSH jump: [user@]host[:port]
    const withoutUser = value.includes('@') ? (value.split('@').pop() ?? value) : value;
    const hostPart = withoutUser.split(':')[0];
    return hostPart ?? undefined;
  }
  return undefined;
}

/**
 * Best-effort extraction of every remote host a network-client invocation
 * targets, for the sole purpose of exempting loopback-only commands from the web
 * egress rejection below. Understands a bare/`scheme://` URL argument and the
 * `user@host` / `host:path` forms `ssh`/`scp`/`sftp` accept, extracts hosts from
 * destination-bearing options like proxies and jump hosts, and skips the value
 * token of ordinary value-taking options so they are never misread as hosts.
 * For SSH, only examines the first positional argument (the destination),
 * not remote command arguments. For SCP/SFTP, examines all positional arguments.
 * Returns an empty array when no host-shaped argument is found, which the
 * caller treats as non-local (fail closed) rather than as evidence the
 * command is safe.
 */
function networkCommandHosts(tokens: string[]): string[] {
  const name = commandName(tokens);
  const valueOptions = NETWORK_TOOL_VALUE_OPTIONS[name];
  const destinationOptions = NETWORK_TOOL_DESTINATION_OPTIONS[name];
  const hosts: string[] = [];
  const rest = tokens.slice(1);

  // For SSH, track whether we've seen the destination yet
  // to avoid parsing remote command arguments
  let ssSeenDestination = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('-')) {
      const eqIndex = token.indexOf('=');
      const flagName = eqIndex === -1 ? token : token.slice(0, eqIndex);

      // Check for destination-bearing options (proxy, jump host, etc.)
      if (destinationOptions?.has(flagName) === true) {
        let destValue: string | undefined;
        if (eqIndex !== -1) {
          // --proxy=http://proxy.example format
          destValue = token.slice(eqIndex + 1);
        } else if (i + 1 < rest.length) {
          // --proxy http://proxy.example format
          destValue = rest[i + 1];
          i += 1; // skip the value token
        }
        if (destValue) {
          const host = extractHostFromDestinationOption(flagName, destValue);
          if (host) {
            hosts.push(host);
          }
        }
        continue;
      }

      // Check for ordinary value-taking options
      if (eqIndex === -1 && valueOptions?.has(flagName) === true) {
        i += 1;
      }
      continue;
    }

    // For SSH, only parse the first positional argument (destination)
    // and stop before any remote command arguments
    if (name === 'ssh') {
      if (ssSeenDestination) {
        // Skip remote command and its arguments
        break;
      }
      ssSeenDestination = true;
    }

    // For SCP/SFTP, skip local paths and only parse remote destinations
    if (name === 'scp' || name === 'sftp') {
      if (!looksLikeRemoteDestination(token)) {
        // Skip local paths
        continue;
      }
    }

    // Parse positional argument as a URL or SSH-style destination
    const withoutUser = token.includes('@') ? (token.split('@').pop() ?? token) : token;
    const candidate = withoutUser.includes('://') ? withoutUser : `http://${withoutUser}`;
    try {
      const url = new URL(candidate);
      if (url.hostname.length > 0) {
        hosts.push(url.hostname);
      }
    } catch {
      continue;
    }
  }
  return hosts;
}

/**
 * Refuse an exec command that reaches an external host through a standalone
 * network client (`curl`, `wget`, `ssh`, ...) when the session has a web
 * connector configured — a slow, many-step "read a search result, then curl
 * and grep raw pages" loop the connector's own fetch/extract tool replaces in
 * one call. Loopback hosts are exempt. Returns `undefined` when no web
 * connector is configured (current behaviour is unchanged) or when the
 * command does not target the network at all.
 */
export function sandboxCommandWebEgressRejection(input: {
  command: string;
  webConnectorAttached: boolean;
  webConnectorToolHint: string;
}): string | undefined {
  if (!input.webConnectorAttached) {
    return undefined;
  }

  let matchedTool: string | undefined;
  const findNonLocalNetworkTool = (tokens: string[], depth = 0): boolean => {
    const resolved = resolveEnvironmentCommand(tokens);
    if (resolved.unsafe) {
      return false;
    }
    const name = commandName(resolved.commandTokens);
    if (NETWORK_COMMANDS.has(name)) {
      const hosts = networkCommandHosts(resolved.commandTokens);
      // Fail closed when no host-shaped argument was found at all, and otherwise reject as soon
      // as any one destination is non-local — a local first argument must not exempt a later one
      // (`curl http://localhost http://example.com`).
      const targetsExternal = hosts.length === 0 || hosts.some(host => !isLocalNetworkHost(host));
      if (targetsExternal) {
        matchedTool = name;
        return true;
      }
      return false;
    }
    const nested = nestedCommandTokens(resolved.commandTokens);
    const nextDepth = nextIndirectDepth(depth);
    return (
      nested !== undefined && nextDepth !== undefined && nested.some(item => findNonLocalNetworkTool(item, nextDepth))
    );
  };

  const targetsExternalHost = tokenize(commandForTokenizing(input.command)).some(candidate =>
    findNonLocalNetworkTool(candidate.tokens),
  );
  if (!targetsExternalHost || matchedTool === undefined) {
    return undefined;
  }
  return `${matchedTool} to an external host is refused because a web connector is configured; use ${input.webConnectorToolHint} to fetch web content instead.`;
}

/**
 * Repository setup mutates the sandbox but is not evidence that the requested
 * source change has begun. Keep this separate from the admission effect: clone
 * and checkout still require approval even though they do not satisfy the
 * agent loop's coding-progress guard.
 */
export function sandboxCommandIsOnlyRepositorySetup(command: string): boolean {
  let sawSetup = false;
  for (const candidate of tokenize(commandForTokenizing(command))) {
    if (candidate.unsafe || candidate.tokens.length === 0) {
      return false;
    }
    const name = commandName(candidate.tokens);
    if (name === 'cd' || singleCommandEffect(candidate) === 'inspect') {
      continue;
    }
    if (name !== 'git') {
      return false;
    }
    const subcommand = parseGitCommand(candidate.tokens).subcommand;
    if (subcommand === undefined || !GIT_REPOSITORY_SETUP_COMMANDS.has(subcommand)) {
      return false;
    }
    sawSetup = true;
  }
  return sawSetup;
}

function singleCommandEffect(command: TokenizedCommand, depth = 0): SandboxCommandSafetyEffect {
  if (command.unsafe || command.tokens.length === 0) {
    return 'execute';
  }
  const resolved = resolveEnvironmentCommand(command.tokens);
  if (resolved.unsafe) {
    return 'execute';
  }
  if (resolved.hadEnvironmentPrefix) {
    const effect = singleCommandEffect({ tokens: resolved.commandTokens, unsafe: false }, depth);
    // Environment changes can make an otherwise read-only command execute
    // helpers or pagers, but they must never hide a known stronger effect.
    return effect === 'inspect' ? 'execute' : effect;
  }
  const name = commandName(command.tokens);
  if (EXECUTION_WRAPPER_SPECS.has(name)) {
    const nested = nestedCommandTokens(command.tokens);
    const nextDepth = nextIndirectDepth(depth);
    if (nested?.length !== 1 || nextDepth === undefined) {
      return 'execute';
    }
    return singleCommandEffect({ tokens: nested[0] ?? [], unsafe: false }, nextDepth);
  }
  if (name === 'xargs') {
    const nested = nestedCommandTokens(command.tokens);
    const nextDepth = nextIndirectDepth(depth);
    if (nested === undefined || nextDepth === undefined) {
      return 'execute';
    }
    return singleCommandEffect({ tokens: nested[0] ?? [], unsafe: false }, nextDepth);
  }
  if (name === 'git') {
    return gitEffect(command.tokens);
  }
  if (name === 'find') {
    if (command.tokens.some(token => /^(?:-delete|-fprint|-fprint0|-fprintf|-fls)$/u.test(token.toLowerCase()))) {
      return 'edit';
    }
    const nested = nestedCommandTokens(command.tokens);
    const nextDepth = nextIndirectDepth(depth);
    if (nested === undefined || nextDepth === undefined) {
      return 'execute';
    }
    return nested.reduce<SandboxCommandSafetyEffect>((current, candidate) => {
      const effect = singleCommandEffect({ tokens: candidate, unsafe: false }, nextDepth);
      return EFFECT_PRIORITY[effect] > EFFECT_PRIORITY[current] ? effect : current;
    }, 'inspect');
  }
  if (name === 'rg' && command.tokens.some(token => token === '--pre' || token.startsWith('--pre='))) {
    return 'execute';
  }
  if (name === 'sed') {
    return command.tokens.some(token => token === '-i' || token.startsWith('-i')) ? 'edit' : 'inspect';
  }
  if (name === 'sort' && command.tokens.some(token => token === '-o' || token.startsWith('--output='))) {
    return 'edit';
  }
  if (EDIT_COMMANDS.has(name)) {
    return 'edit';
  }
  if (INSPECT_COMMANDS.has(name)) {
    return 'inspect';
  }
  if (name === 'cd' || (name === 'command' && command.tokens[1] === '-v')) {
    return 'inspect';
  }
  return 'execute';
}

const EFFECT_PRIORITY: Record<SandboxCommandSafetyEffect, number> = {
  inspect: 0,
  edit: 1,
  execute: 2,
  commit: 3,
  push: 4,
};

/** Conservative syntax classification used only as a host-owned safety floor. */
export function sandboxCommandEffect(command: string): SandboxCommandSafetyEffect {
  return tokenize(commandForTokenizing(command)).reduce<SandboxCommandSafetyEffect>((current, candidate) => {
    const effect = singleCommandEffect(candidate);
    return EFFECT_PRIORITY[effect] > EFFECT_PRIORITY[current] ? effect : current;
  }, 'inspect');
}

function sandboxCommandSafetyEffects(command: string): ReadonlySet<SandboxCommandSafetyEffect> {
  return new Set(tokenize(commandForTokenizing(command)).map(singleCommandEffect));
}

/** Resolve the model-declared purpose without allowing it to lower the syntax safety floor. */
export function sandboxInvocationPolicy(input: {
  command: string;
  purpose: SandboxInvocationPurpose;
}): SandboxInvocationPolicy {
  const safetyEffect = sandboxCommandEffect(input.command);
  const safetyEffects = sandboxCommandSafetyEffects(input.command);
  if (input.purpose === 'verify') {
    const prohibitedEffect = (['edit', 'commit', 'push'] as const).find(effect => safetyEffects.has(effect));
    if (prohibitedEffect !== undefined) {
      return {
        effect: 'verify',
        rejection: `A verification invocation cannot contain a command classified as ${prohibitedEffect}.`,
      };
    }
    return { effect: 'verify', rejection: undefined };
  }
  if (input.purpose === 'commit' && safetyEffect !== 'commit') {
    return { effect: 'commit', rejection: 'The commit purpose requires a Git commit command.' };
  }
  if (input.purpose === 'push' && safetyEffect !== 'push') {
    return { effect: 'push', rejection: 'The push purpose requires a Git push command.' };
  }
  if (input.purpose === 'inspect') {
    return { effect: safetyEffect, rejection: undefined };
  }
  if (input.purpose === 'edit') {
    return {
      effect: safetyEffect === 'commit' || safetyEffect === 'push' ? safetyEffect : 'edit',
      rejection: undefined,
    };
  }
  if (input.purpose === 'execute') {
    return { effect: safetyEffect === 'inspect' ? 'execute' : safetyEffect, rejection: undefined };
  }
  return { effect: input.purpose, rejection: undefined };
}

export function sandboxCommandRequiresApproval(effect: SandboxCommandEffect): boolean {
  return effect !== 'inspect';
}

/**
 * A shell pipeline reports only its final command's status unless pipefail is
 * enabled. Reject piped verification rather than accepting a green `head` or
 * `tee` after the compiler/test command failed.
 */
export function sandboxVerifyCommandMasksExitStatus(command: string): boolean {
  const hasPipefail = /(?:^|[;&]\s*)set\s+-o\s+pipefail(?:\s|[;&]|$)/.test(command);
  const withoutLeadingPipefail = command.replace(/^\s*set\s+-o\s+pipefail\s*;\s*/, '');
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < withoutLeadingPipefail.length; index += 1) {
    const character = withoutLeadingPipefail[index];
    const next = withoutLeadingPipefail[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '&' && next === '&') {
      index += 1;
      continue;
    }
    if (
      character === ';' ||
      character === '\n' ||
      character === '\r' ||
      (character === '|' && next === '|') ||
      character === '&'
    ) {
      return true;
    }
  }
  return hasUnquotedPipeOperator(withoutLeadingPipefail) && !hasPipefail;
}

/** Reject redirection, command substitution, backgrounding, and malformed quoting on verification calls. */
export function sandboxVerifyCommandUsesUnsafeSyntax(command: string): boolean {
  return tokenize(stripFileDescriptorMerges(command)).some(candidate => candidate.unsafe);
}
