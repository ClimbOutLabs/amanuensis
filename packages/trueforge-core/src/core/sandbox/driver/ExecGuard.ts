/**
 * Harness-level guard for the exec tool path.
 *
 * exec is for repository and workspace commands: git, build, test, file inspection, and running a
 * program that is a file in the workspace (`python3 main.py`, `node server.js`). Code that is not a
 * file (`python3 -c`, a heredoc, code piped in, a bare interpreter) is rejected with an error
 * pointing at `run_code`, which is where one-off code belongs.
 *
 * Classification is by RESOLVED EXECUTABLE + OPERAND SHAPE, not just syntactic forms: argv[0] is
 * resolved through PATH and `sh -c`/`bash -c`/`env` wrappers are unwrapped. PATH lookup is injected
 * so the pure classifier is unit-testable.
 *
 * This guard prevents accidental drift, not a malicious model: whether a command needs approval is
 * decided by the permission rules, which see every script run.
 */

export interface ExecGuardHost {
  /** Resolve a bare command name through PATH; undefined when not found. */
  resolveExecutable: (name: string) => string | undefined;
}

export type ExecGuardVerdict = { verdict: 'allow' } | { verdict: 'reject'; reason: string };

const DATA_INTERPRETERS = new Set(['python', 'python3', 'node', 'nodejs', 'ruby', 'perl']);

function isDataInterpreterBasename(base: string): boolean {
  if (DATA_INTERPRETERS.has(base)) {
    return true;
  }
  // Versioned python binaries: python3.13, python3.12, …
  return /^python3\.\d+$/.test(base);
}

const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh']);

/**
 * Code-flag letters per interpreter family, matched ANYWHERE in short
 * clusters: python `-uc`/`-Buc`/`-Suc` execute; node
 * `-pe` and `--eval`/`--print` execute; perl `-lne`/`-pE`/`-nE` execute.
 * A plain `-u`, `-S`, `-`, or `--version` carries no code letter and stays
 * allowed. An arg-taking short flag that swallows the code letter
 * (e.g. python `-Wuc`, where `-W` consumes `uc`) is over-rejected on
 * purpose — fail closed on ambiguous clusters.
 */
function codeFlagPattern(base: string): RegExp | undefined {
  if (base.startsWith('python')) {
    return /^-[A-Za-z]*c/;
  }
  if (base === 'node' || base === 'nodejs') {
    return /^-[A-Za-z]*[ep]/;
  }
  if (base === 'perl') {
    return /^-[A-Za-z]*[eE]/;
  }
  if (base === 'ruby') {
    return /^-[A-Za-z]*[e]/;
  }
  return undefined;
}

/**
 * Modules exec may run with `python -m`: the ones a Python project is built and tested with. Each
 * runs the project's own tests or installs packages, the same as calling `pytest` or `pip` directly.
 * Any other module (pdb, runpy, cProfile, timeit, code, http.server, ...) can run arbitrary code or
 * serve the workspace, so it goes to run_code like any other code.
 */
const PYTHON_BUILD_AND_TEST_MODULES: ReadonlySet<string> = new Set(['pytest', 'pip', 'venv', 'unittest']);

/**
 * Finds python's `-m <module>` (also clustered, `-Bm pytest` or `-mpytest`) among the options that
 * come before any script operand. `optionCount` is how many operands are python's own options, up to
 * and including the one naming the module; later operands belong to the module. `valid` is whether
 * the module is one exec may run. Undefined when the command does not use `-m`.
 */
function pythonModuleInvocation(operands: readonly string[]): { optionCount: number; valid: boolean } | undefined {
  for (let index = 0; index < operands.length; index += 1) {
    const op = operands[index] ?? '';
    if (op === '-' || op === '--' || !op.startsWith('-')) {
      return undefined;
    }
    if (op.startsWith('--')) {
      continue;
    }
    const at = op.indexOf('m', 1);
    if (at === -1) {
      continue;
    }
    const attached = op.slice(at + 1);
    const moduleName = attached.length > 0 ? attached : operands[index + 1];
    const optionCount = attached.length > 0 ? index + 1 : index + 2;
    return { optionCount, valid: moduleName !== undefined && PYTHON_BUILD_AND_TEST_MODULES.has(moduleName) };
  }
  return undefined;
}

/** Interpreter options that take no value of their own, so the word after them is the script. */
const PYTHON_PLAIN_OPTIONS: ReadonlySet<string> = new Set(['-u', '-B', '-E', '-I', '-O', '-OO', '-s', '-S', '-q']);
const NODE_PLAIN_OPTIONS: ReadonlySet<string> = new Set([
  '--enable-source-maps',
  '--experimental-strip-types',
  '--no-warnings',
  '--trace-warnings',
]);

/**
 * The operands that belong to the interpreter and not to the script it runs: the options before the
 * script file. What follows the script is the script's own, so a `-c` there is not inline code. This
 * is only trusted when every option before the script is known to take no value; with any other
 * option the script cannot be told from that option's value, so every operand is checked.
 */
function interpreterOwnOperands(input: { base: string; operands: readonly string[] }): readonly string[] {
  const plain = input.base.startsWith('python') ? PYTHON_PLAIN_OPTIONS : NODE_PLAIN_OPTIONS;
  const script = input.operands.findIndex(op => !op.startsWith('-'));
  if (script === -1) {
    return input.operands;
  }
  const options = input.operands.slice(0, script);
  return options.every(op => plain.has(op)) ? options : input.operands;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

interface Token {
  text: string;
}

interface TokenizeResult {
  tokens: Token[];
  /** A heredoc operator (<<, <<-, quoted) appeared anywhere. */
  hasHeredoc: boolean;
}

/**
 * Minimal shell-word tokenizer: single/double quotes, backslash escapes, and
 * heredoc-operator detection. Command separators (;, &&, ||, |, &, newlines)
 * become boundary markers so each pipeline segment is classified separately.
 */
const SEGMENT_BOUNDARY = '\u0000';

function tokenize(command: string): TokenizeResult {
  const tokens: Token[] = [];
  let current = '';
  let hasToken = false;
  let hasHeredoc = false;
  let i = 0;
  const n = command.length;

  const pushToken = (): void => {
    if (hasToken) {
      tokens.push({ text: current });
      current = '';
      hasToken = false;
    }
  };
  const pushBoundary = (): void => {
    pushToken();
    tokens.push({ text: SEGMENT_BOUNDARY });
  };

  while (i < n) {
    const ch = command.charAt(i);
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const literal = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      current += literal;
      hasToken = true;
      i = end === -1 ? n : end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n) {
          buf += command.charAt(j + 1);
          j += 2;
        } else {
          buf += command.charAt(j);
          j += 1;
        }
      }
      current += buf;
      hasToken = true;
      i = j + 1;
    } else if (ch === '\\' && i + 1 < n) {
      current += command.charAt(i + 1);
      hasToken = true;
      i += 2;
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\n') {
        pushBoundary();
      } else {
        pushToken();
      }
      i += 1;
    } else if (ch === ';' || ch === '&' || ch === '|') {
      // &&, ||, ;; collapse to one boundary; a lone & or | is a boundary too.
      while (i < n && (command[i] === ';' || command[i] === '&' || command[i] === '|')) {
        i += 1;
      }
      pushBoundary();
    } else if (ch === '(' || ch === ')') {
      pushBoundary();
      i += 1;
    } else if (ch === '<' && command[i + 1] === '<') {
      hasHeredoc = true;
      // Consume <<, <<-, and the delimiter word that follows.
      i += 2;
      if (command[i] === '-') {
        i += 1;
      }
      while (i < n && (command[i] === ' ' || command[i] === '\t')) {
        i += 1;
      }
      if (command.charAt(i) === "'" || command.charAt(i) === '"') {
        const quote = command.charAt(i);
        const end = command.indexOf(quote, i + 1);
        i = end === -1 ? n : end + 1;
      } else {
        while (i < n && !' \t\r\n;&|()'.includes(command.charAt(i))) {
          i += 1;
        }
      }
      pushToken();
    } else {
      current += ch;
      hasToken = true;
      i += 1;
    }
  }
  pushToken();
  return { tokens, hasHeredoc };
}

/** Split tokens into pipeline segments at boundary markers. */
function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.text === SEGMENT_BOUNDARY) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(token.text);
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/**
 * If the segment is a `sh -c '…'` / `bash -lc '…'` / `env …` wrapper, return
 * the inner COMMAND STRING for recursive classification. Undefined when the
 * segment is not a wrapper.
 */
function unwrapSegmentCommand(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  const firstArg = argv[0];
  if (firstArg === undefined) {
    return undefined;
  }
  const first = basenameOf(firstArg);
  if (SHELL_NAMES.has(first)) {
    // sh -c <cmd> / bash -lc <cmd> / sh -ec <cmd>
    for (let k = 1; k < argv.length; k += 1) {
      const flag = argv[k];
      if (flag === undefined) {
        break;
      }
      if (flag.startsWith('-') && flag.includes('c') && flag !== '-') {
        return argv[k + 1];
      }
      if (!flag.startsWith('-') || flag === '-') {
        break;
      }
    }
    return undefined;
  }
  if (first === 'env') {
    let k = 1;
    // env [-i] [VAR=val …] <command>
    while (k < argv.length) {
      const token = argv[k];
      if (token === undefined) {
        break;
      }
      if (token === '-i' || token === '-') {
        k += 1;
        continue;
      }
      if (token.startsWith('-') || token.includes('=')) {
        k += 1;
        continue;
      }
      break;
    }
    const rest = argv.slice(k);
    return rest.length > 0 ? rest.join(' ') : undefined;
  }
  return undefined;
}

function classifySegment(input: { argv: string[]; hasHeredoc: boolean; host: ExecGuardHost }): ExecGuardVerdict {
  // Leading `VAR=value` assignments (`FOO=1 python3 -c …`) are shell env
  // prefixes, not the command — strip them before classification.
  let argv = input.argv;
  let skip = 0;
  while (skip < argv.length) {
    const token = argv[skip];
    if (token === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      break;
    }
    skip += 1;
  }
  if (skip > 0) {
    argv = argv.slice(skip);
  }
  // A variable or substitution in the command position (`$X`, `$(…)`,
  // backtick-wrapped names) defeats PATH resolution and falls through to
  // allow — reject it outright; name the executable explicitly.
  const head = argv[0];
  if (head !== undefined && /[$`]/.test(head)) {
    return {
      verdict: 'reject',
      reason: 'exec must not use shell expansion in the command position: name the executable explicitly',
    };
  }
  // A wrapper segment is classified by its inner command, recursively, so
  // multi-segment payloads (sh -c 'git status; python3 -c "…"') are caught.
  const inner = unwrapSegmentCommand(argv);
  if (inner !== undefined) {
    return classifyExecCommand({ command: inner, host: input.host });
  }
  if (argv.length === 0) {
    return { verdict: 'allow' };
  }
  const invoked = argv[0];
  if (invoked === undefined) {
    return { verdict: 'allow' };
  }
  const resolved = invoked.includes('/') ? invoked : (input.host.resolveExecutable(invoked) ?? invoked);
  const base = basenameOf(resolved);

  if (isDataInterpreterBasename(base)) {
    const operands = argv.slice(1);
    if (operands.length === 0) {
      return {
        verdict: 'reject',
        reason: `exec must not start ${base} with no script file: name the file to run, or use the run_code tool for code that is not a file`,
      };
    }
    // Code flags match ANYWHERE in short clusters (`-uc`, `-pe`, `-lne`
    // all execute) plus node's `--eval`/`--print` long forms. Single-dash
    // safe flags (`-u`, `-S`, `-`, `--version`) carry no code letter and
    // stay allowed.
    const codeFlag = codeFlagPattern(base);
    const isNode = base === 'node' || base === 'nodejs';
    const pythonModule = base.startsWith('python') ? pythonModuleInvocation(operands) : undefined;
    const optionOperands =
      pythonModule === undefined
        ? interpreterOwnOperands({ base, operands })
        : operands.slice(0, pythonModule.optionCount);
    const runsCode = optionOperands.some(
      op => codeFlag?.test(op) === true || (isNode && /^--(eval|print)(=|$)/.test(op)),
    );
    if (runsCode) {
      return {
        verdict: 'reject',
        reason: `exec must not run ${base} with inline code (-c for python, -e/-p/--eval/--print for node, -e for perl and ruby): use the run_code tool instead`,
      };
    }
    if (input.hasHeredoc) {
      return {
        verdict: 'reject',
        reason: `exec must not run ${base} with heredoc input: use the run_code tool instead`,
      };
    }
    if (pythonModule !== undefined) {
      // `python3 -m pytest`, `-m pip`, `-m venv`, `-m unittest`: the way a project is built and
      // tested. Everything after the module name is that module's own arguments, so it is not read
      // as a script file.
      return pythonModule.valid
        ? { verdict: 'allow' }
        : {
            verdict: 'reject',
            reason: `exec runs ${base} -m only for pytest, pip, venv or unittest; run any other module with the run_code tool`,
          };
    }
    if (operands.some(op => op === '-')) {
      return {
        verdict: 'reject',
        reason: `exec must not pipe code into ${base} via stdin: use the run_code tool instead`,
      };
    }
    // A script file, or flags only (python3 --version, node --help): a program in the workspace is
    // run like any other project command, and the permission rules decide whether it needs a card.
    return { verdict: 'allow' };
  }
  return { verdict: 'allow' };
}

/**
 * Classify a full exec command. Rejects when ANY pipeline segment is an
 * interpreter invocation. Resolution results should be cached by the host.
 */
export function classifyExecCommand(input: { command: string; host: ExecGuardHost }): ExecGuardVerdict {
  const { tokens, hasHeredoc } = tokenize(input.command);
  const segments = splitSegments(tokens);
  for (const argv of segments) {
    const verdict = classifySegment({ argv, hasHeredoc, host: input.host });
    if (verdict.verdict === 'reject') {
      return verdict;
    }
  }
  return { verdict: 'allow' };
}

/**
 * The model-facing refusal: invalid_input-style, pointing at run_code, with
 * the anti-workaround rule restated.
 */
export function interpreterInvocationRefusal(reason: string): string {
  return (
    `Invalid exec input: ${reason}. ` +
    `exec runs repository and workspace commands (git, build, test, file inspection) and programs that are files in the workspace, ` +
    `such as python3 main.py or node server.js. Code that is not a file goes to the run_code tool. ` +
    `python3 -m pytest, -m pip, -m venv and -m unittest are allowed. ` +
    `Do not work around this by renaming the interpreter or wrapping the invocation.`
  );
}
