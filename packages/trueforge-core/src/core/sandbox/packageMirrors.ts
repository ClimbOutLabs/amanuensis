/**
 * Package downloads through Aman's mirrors: the shared facts the sandbox layers need.
 *
 * The mirrors themselves live in the server (packages/trueforge/src/sandbox/mirrors). This module owns
 * only the decisions the sandbox makes before a command runs: whether a command would download
 * packages at all, and whether the project's own files name a package the mirrors cannot serve
 * because it comes from a git address.
 */

/** Said to the person, through the tool result, when a project needs a package from a git address. */
export const PACKAGE_GIT_DEPENDENCY_MESSAGE =
  "This project needs a package from a git address, which the sandbox can't reach yet. " +
  "Replace it with the package's name and version from the package registry, then try again.";

/**
 * Dependency files read when a download command runs in a repo that allows package downloads.
 * Bounded on purpose: these are the files the four package tools read their dependency lists from.
 */
export const PACKAGE_MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'Pipfile',
  'Cargo.toml',
] as const;

/** Shell characters that end one command and start another, subshell and substitution edges included. */
const SEGMENT_BREAKS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')', '`']);

/**
 * Splits a shell command into simple commands as word lists. Deliberately small: quotes are honoured,
 * and subshells and command substitutions start commands of their own. The callers only use this to
 * recognise package tool invocations, and a miss fails safe: the command runs with no mirror grant
 * attached, exactly as it did before mirrors existed.
 */
export function splitShellCommands(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: string | undefined;
  const flushWord = (): void => {
    if (word !== '') {
      words.push(word);
      word = '';
    }
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) {
      segments.push(words);
      words = [];
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === '\\' && quote === '"') {
        const next = command[i + 1];
        if (next !== undefined) {
          word += next;
          i += 1;
        }
      } else {
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next !== undefined) {
        word += next;
        i += 1;
      }
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      flushSegment();
      i += 1;
      continue;
    }
    if (SEGMENT_BREAKS.has(ch)) {
      flushSegment();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord();
      continue;
    }
    word += ch;
  }
  flushSegment();
  return segments;
}

/** Shell keywords and grouping words that can stand before a command without changing it. */
const LEADING_KEYWORDS = new Set([
  '{',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'exec',
  'builtin',
  'command',
  'nohup',
]);

/** Wrappers that run the command after them, with the flags of theirs that take a value. */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  time: new Set(['-f', '-o', '--format', '--output']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set([
    '-I',
    '-i',
    '-n',
    '-P',
    '-L',
    '-l',
    '-d',
    '-a',
    '-E',
    '-e',
    '-s',
    '--max-args',
    '--max-procs',
    '--delimiter',
    '--arg-file',
    '--replace',
  ]),
};

/**
 * The words that name the program and its arguments, after anything that only wraps it: env
 * assignments, shell keywords, and wrappers such as sudo, env, time, nice, timeout and xargs with
 * their own flags. timeout's duration is its first plain word, so it is passed over too.
 */
function programWords(words: readonly string[]): string[] {
  let index = 0;
  for (;;) {
    const word = words[index];
    if (word === undefined) {
      return [];
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || LEADING_KEYWORDS.has(word)) {
      index += 1;
      continue;
    }
    const valueFlags = Object.hasOwn(WRAPPER_VALUE_FLAGS, word) ? WRAPPER_VALUE_FLAGS[word] : undefined;
    if (valueFlags === undefined) {
      return words.slice(index);
    }
    index += 1;
    for (;;) {
      const flag = words[index];
      if (!flag?.startsWith('-')) {
        break;
      }
      index += !flag.includes('=') && valueFlags.has(flag) ? 2 : 1;
    }
    if (word === 'timeout' && words[index] !== undefined) {
      index += 1;
    }
  }
}

/** The package family one simple command downloads from, named by its mirror; `any` when the tool is not known. */
type PackageDownloadEcosystem = 'pypi' | 'npm' | 'go' | 'cargo' | 'any';

/** How each package site is named in words a person reads. */
const PACKAGE_SITE_NAMES: Record<Exclude<PackageDownloadEcosystem, 'any'>, string> = {
  pypi: 'PyPI',
  npm: 'npm',
  go: 'the Go package site',
  cargo: 'crates.io',
};

/** The sites a command of one family can download from: every site when the tool is not known. */
function siteNamesFor(ecosystem: PackageDownloadEcosystem): string[] {
  return ecosystem === 'any' ? Object.values(PACKAGE_SITE_NAMES) : [PACKAGE_SITE_NAMES[ecosystem]];
}

/** pip, pip3 and pinned spellings such as pip3.12. */
const PIP_PROGRAM = /^pip(?:\d+(?:\.\d+)?)?$/;
/** python, python3 and pinned spellings such as python3.12. */
const PYTHON_PROGRAM = /^python(?:\d+(?:\.\d+)?)?$/;
const NPM_PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_INSTALL_WORDS = new Set(['install', 'i', 'ci', 'add', 'update', 'upgrade', 'install-test', 'it']);
/** Script and make target names that, by wide convention, fetch a project's dependencies. */
const SETUP_SCRIPT_NAMES = new Set([
  'install',
  'setup',
  'bootstrap',
  'deps',
  'dependencies',
  'postinstall',
  'prepare',
  'init',
  'vendor',
]);
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** How deep shell -c, eval and alias text is followed: enough for real commands, bounded for hostile ones. */
const MAX_NESTING = 4;

/** One simple command that can fetch packages: its ecosystem, and whether installing is its point. */
interface SegmentDownload {
  ecosystem: PackageDownloadEcosystem;
  /**
   * True when downloading packages is what the command is for (an install, an add, a sync).
   * False when the command only might fetch while doing something else (a build, a test, a
   * run, a fetch-and-run tool): those run without a download grant, and the downloads-off
   * note explains it if they do try to download. Only explicit installs ask on the
   * first-download card and record the allowance when approved.
   */
  explicit: boolean;
}

/** The download one simple command can make, or undefined when it downloads none. */
function segmentDownload(argv: readonly string[]): SegmentDownload | undefined {
  const program = argv[0];
  if (program === undefined) {
    return undefined;
  }
  const base = program.slice(program.lastIndexOf('/') + 1);
  const sub = argv[1];
  if (PIP_PROGRAM.test(base) && (sub === 'install' || sub === 'download')) {
    return { ecosystem: 'pypi', explicit: true };
  }
  if (
    PYTHON_PROGRAM.test(base) &&
    argv[1] === '-m' &&
    argv[2] !== undefined &&
    PIP_PROGRAM.test(argv[2]) &&
    (argv[3] === 'install' || argv[3] === 'download')
  ) {
    return { ecosystem: 'pypi', explicit: true };
  }
  if (base === 'pipx' && (sub === 'install' || sub === 'inject' || sub === 'upgrade')) {
    return { ecosystem: 'pypi', explicit: true };
  }
  if (base === 'pipx' && sub === 'run') {
    return { ecosystem: 'pypi', explicit: false };
  }
  if (base === 'pip-sync') {
    return { ecosystem: 'pypi', explicit: true };
  }
  if (
    (base === 'pdm' || base === 'pipenv') &&
    (sub === 'install' || sub === 'add' || sub === 'sync' || sub === 'update')
  ) {
    return { ecosystem: 'pypi', explicit: true };
  }
  if (NPM_PROGRAMS.has(base) && sub !== undefined && NPM_INSTALL_WORDS.has(sub)) {
    return { ecosystem: 'npm', explicit: true };
  }
  // A bare yarn or bun installs the project's dependencies.
  if ((base === 'yarn' || base === 'bun') && (sub === undefined || sub.startsWith('-'))) {
    return { ecosystem: 'npm', explicit: true };
  }
  // npx, bunx and dlx fetch the package they are asked to run when it is not installed.
  if (base === 'npx' || base === 'bunx' || ((base === 'pnpm' || base === 'yarn') && sub === 'dlx')) {
    return { ecosystem: 'npm', explicit: false };
  }
  if (NPM_PROGRAMS.has(base) && (sub === 'run' || sub === 'run-script') && SETUP_SCRIPT_NAMES.has(argv[2] ?? '')) {
    return { ecosystem: 'npm', explicit: false };
  }
  if ((base === 'yarn' || base === 'pnpm') && sub !== undefined && SETUP_SCRIPT_NAMES.has(sub) && sub !== 'install') {
    return { ecosystem: 'npm', explicit: false };
  }
  if (base === 'make' && argv.slice(1).some(word => !word.startsWith('-') && SETUP_SCRIPT_NAMES.has(word))) {
    return { ecosystem: 'any', explicit: false };
  }
  if (base === 'cargo' && (sub === 'fetch' || sub === 'update' || sub === 'add' || sub === 'install')) {
    return { ecosystem: 'cargo', explicit: true };
  }
  if (base === 'cargo' && (sub === 'build' || sub === 'test' || sub === 'run' || sub === 'check' || sub === 'clippy')) {
    return { ecosystem: 'cargo', explicit: false };
  }
  if (base === 'go' && (sub === 'get' || sub === 'install')) {
    return { ecosystem: 'go', explicit: true };
  }
  if (base === 'go' && (sub === 'build' || sub === 'test' || sub === 'run' || sub === 'vet')) {
    return { ecosystem: 'go', explicit: false };
  }
  if (base === 'go' && sub === 'mod' && (argv[2] === 'download' || argv[2] === 'tidy' || argv[2] === 'vendor')) {
    return { ecosystem: 'go', explicit: true };
  }
  if (
    (base === 'uv' && sub === 'pip' && argv[2] === 'install') ||
    (base === 'uv' && (sub === 'sync' || sub === 'add')) ||
    (base === 'uv' && sub === 'tool' && argv[2] === 'install')
  ) {
    return { ecosystem: 'pypi', explicit: true };
  }
  if ((base === 'uv' && sub === 'run') || (base === 'uv' && sub === 'tool' && argv[2] === 'run') || base === 'uvx') {
    return { ecosystem: 'pypi', explicit: false };
  }
  if (base === 'poetry' && (sub === 'install' || sub === 'add' || sub === 'update')) {
    return { ecosystem: 'pypi', explicit: true };
  }
  // A program held in a variable ($p install ...) could be any package tool.
  if (
    program.startsWith('$') &&
    sub !== undefined &&
    (NPM_INSTALL_WORDS.has(sub) || sub === 'download' || sub === 'get' || sub === 'sync')
  ) {
    return { ecosystem: 'any', explicit: false };
  }
  return undefined;
}

/** One simple command that can fetch packages, with the words that name it and its arguments. */
interface DownloadCommand {
  ecosystem: PackageDownloadEcosystem;
  explicit: boolean;
  argv: readonly string[];
}

/** A Python string literal, with any prefix such as r, b or f. */
const PYTHON_STRING = /[rbfuRBFU]{0,2}(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
/** Python calls that run a command: os.system, os.popen, the subprocess functions, and pip's own main. */
const PYTHON_COMMAND_CALL =
  /\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|getoutput|getstatusoutput|Popen)|pip(?:\._internal)?\.main)\s*\(/g;

/** The text between a call's opening parenthesis at `open` and its matching close, quotes honoured. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  return text.slice(open + 1);
}

/**
 * The commands Python code runs through os.system, subprocess and pip.main, as word lists. A list
 * argument becomes the words of one command, with sys.executable read as python; a string argument
 * is read as a shell command.
 */
function pythonCallCommands(text: string): { list: string[] | undefined; shell: string | undefined }[] {
  const calls: { list: string[] | undefined; shell: string | undefined }[] = [];
  for (const match of text.matchAll(PYTHON_COMMAND_CALL)) {
    const args = callArguments(text, match.index + match[0].length - 1).trim();
    const isPipMain = match[0].startsWith('pip');
    if (args.startsWith('[') || args.startsWith('(') || isPipMain) {
      const firstArgument = args.startsWith('[') || args.startsWith('(') ? callArguments(args, 0) : args;
      const words: string[] = isPipMain ? ['pip'] : [];
      for (const token of firstArgument.matchAll(new RegExp(`${PYTHON_STRING.source}|sys\\.executable`, 'g'))) {
        words.push(token[0] === 'sys.executable' ? 'python' : (token[1] ?? token[2] ?? ''));
      }
      calls.push({ list: words, shell: undefined });
      continue;
    }
    const literal = new RegExp(PYTHON_STRING.source).exec(args);
    if (literal !== null && literal.index === 0) {
      calls.push({ list: undefined, shell: literal[1] ?? literal[2] ?? '' });
    }
  }
  return calls;
}

/**
 * Every simple command in `text` that downloads packages. Shell -c and eval text, aliases defined
 * earlier in the same text, and commands Python code runs through os.system, subprocess or pip.main
 * are read as commands too.
 */
function downloadCommands(text: string, depth = 0): DownloadCommand[] {
  const found: DownloadCommand[] = [];
  const aliases = new Map<string, string[]>();
  const add = (argv: readonly string[]): void => {
    const download = segmentDownload(argv);
    if (download !== undefined) {
      found.push({ ...download, argv });
    }
  };
  for (const words of splitShellCommands(text)) {
    let argv = programWords(words);
    const first = argv[0];
    if (first === undefined) {
      continue;
    }
    if (first === 'alias') {
      for (const definition of argv.slice(1)) {
        const equals = definition.indexOf('=');
        if (equals > 0) {
          aliases.set(
            definition.slice(0, equals),
            programWords(splitShellCommands(definition.slice(equals + 1))[0] ?? []),
          );
        }
      }
      continue;
    }
    const alias = aliases.get(first);
    if (alias !== undefined) {
      argv = [...alias, ...argv.slice(1)];
    }
    const program = argv[0] ?? '';
    const base = program.slice(program.lastIndexOf('/') + 1);
    if (depth < MAX_NESTING && SHELL_PROGRAMS.has(base)) {
      const flag = argv.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      const script = flag === -1 ? undefined : argv[flag + 1];
      if (script !== undefined) {
        found.push(...downloadCommands(script, depth + 1));
        continue;
      }
    }
    if (depth < MAX_NESTING && base === 'eval') {
      found.push(...downloadCommands(argv.slice(1).join(' '), depth + 1));
      continue;
    }
    if (depth < MAX_NESTING && PYTHON_PROGRAM.test(base)) {
      const flag = argv.indexOf('-c');
      const code = flag === -1 ? undefined : argv[flag + 1];
      if (code !== undefined) {
        found.push(...downloadCommands(code, depth + 1));
        continue;
      }
    }
    add(argv);
  }
  if (depth < MAX_NESTING) {
    for (const call of pythonCallCommands(text)) {
      if (call.list !== undefined) {
        add(programWords(call.list));
      } else if (call.shell !== undefined) {
        found.push(...downloadCommands(call.shell, depth + 1));
      }
    }
  }
  return found;
}

/**
 * What package tools print when they try to download while the sandbox holds no download grant:
 * npm's dead-end registry address, pip with no index, Go with its proxy off, and Cargo offline.
 */
const BLOCKED_DOWNLOAD_SIGNS: readonly RegExp[] = [
  /127\.0\.0\.1:1\b/,
  /No matching distribution found/,
  /GOPROXY=off/,
  /CARGO_NET_OFFLINE|you are in the offline mode|attempting to make an HTTP request, but --offline/i,
];

/** Whether a failed command's output shows a package download the missing grant stopped. */
export function outputShowsBlockedDownload(output: string): boolean {
  return BLOCKED_DOWNLOAD_SIGNS.some(sign => sign.test(output));
}

/**
 * The note added to a failed command's output when it tried to download packages while downloads
 * are off, so the person learns why and what to do instead of reading a network error.
 */
export function packageDownloadsOffNote(scope: { inProject: boolean }): string {
  const setting = scope.inProject ? 'for this repo' : 'for chats without a project';
  return `Package downloads are off ${setting}, so this command could not download packages. To allow them, run the install as a command of its own so Aman can ask you, or turn on package downloads ${setting} in Settings.`;
}

/**
 * What the model is told when a package cannot be downloaded here. The run_code offline text and the
 * slot prompt both say this, so the words stay the same.
 */
export const PACKAGE_UNAVAILABLE_RULE =
  'say that plainly instead of retrying, and do not try another tool to get around it.';

/**
 * Whether a command would make a package tool download packages: installs, and the build and test
 * commands that fetch dependencies first. Only these commands get the git-address check, because only
 * they would try to fetch the dependency.
 */
export function commandDownloadsPackages(command: string): boolean {
  return downloadCommands(command).length > 0;
}

/**
 * Whether a command is an explicit install: downloading packages is its point, not a side
 * effect it might have. Only these commands show the first-download card and record the
 * download allowance when the person approves them. A build, test or run command that only
 * might fetch runs without the card and without a grant.
 */
export function commandInstallsPackages(command: string): boolean {
  return downloadCommands(command).some(download => download.explicit);
}

/** The public package sites a download can come from, named in one list for sentences a person reads. */
export function packageDownloadSitesText(): string {
  const names = siteNamesFor('any');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The sites one command's explicit installs download from, named for the tools used, in order. */
function downloadSiteNames(command: string): string[] {
  const sites: string[] = [];
  for (const { ecosystem, explicit } of downloadCommands(command)) {
    if (!explicit) {
      continue;
    }
    for (const name of siteNamesFor(ecosystem)) {
      if (!sites.includes(name)) {
        sites.push(name);
      }
    }
  }
  return sites;
}

/**
 * The one sentence the first-download approval card shows, or undefined when the command is not
 * an explicit install. The sites are named for the tools this command actually uses, in the
 * order it uses them.
 */
export function packageDownloadCardWhat(command: string): string | undefined {
  const sites = downloadSiteNames(command);
  if (sites.length === 0) {
    return undefined;
  }
  return `Aman wants to download this project's packages from the public package sites (${sites.join(', ')}).`;
}

/**
 * The first-download card sentence for a chat that is not working on a project: the same sites,
 * then what the person is agreeing to, downloads in their chats without a project and in their
 * scheduled runs, which use the same allowance.
 */
export function packageDownloadCardWhatWithoutProject(command: string): string | undefined {
  const sites = downloadSiteNames(command);
  if (sites.length === 0) {
    return undefined;
  }
  return `Aman wants to download packages from the public package sites (${sites.join(
    ', ',
  )}) in your chats that are not working on a project. This also covers your scheduled runs.`;
}

/**
 * Git-address dependency specs in line-based manifests (requirements files, pyproject.toml, Pipfile,
 * Cargo.toml). A match means the package tool would try to clone from a git host, which the mirrors
 * cannot serve. Registry specs (names, versions, paths inside the project) never match.
 */
const GIT_SPEC_PATTERNS: readonly RegExp[] = [
  // pip, pyproject and Poetry style VCS specs: git+https://, hg+ssh://, svn+https:// in a spec.
  // Schemes are matched in any case: pip reads GIT+HTTPS the same as git+https.
  /(?:git|hg|svn|bzr)\+(?:https?|ssh|git|svn|hg):\/\//i,
  // A bare git or ssh address written as the whole spec: git://github.com/org/repo.
  /(?:^|\s)(?:git|ssh):\/\//i,
  // An scp-style git address: git@github.com:org/repo.
  /(?:^|\s)[^\s/@]+@[^\s/:]+:/,
  // A PEP 508 direct reference to a web address (name @ https://...): pip fetches that address
  // itself instead of asking the package index, so the mirrors would never see the download.
  // A file: reference points at this machine instead, so it stays allowed.
  /@\s*(?!file:)[A-Za-z][A-Za-z0-9+.-]*:\/\//i,
  // Cargo and Poetry: a dependency written with a git key.
  /\bgit\s*=\s*["'][^"']+["']/,
];

/** Whether one npm dependency spec names a git address rather than the registry. */
function isGitSpec(spec: string): boolean {
  const value = spec.trim();
  const lower = value.toLowerCase();
  return (
    lower.startsWith('git+') ||
    lower.startsWith('git://') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('github:') ||
    lower.startsWith('gitlab:') ||
    lower.startsWith('bitbucket:') ||
    lower.startsWith('gist:') ||
    // An scp-style git address: git@github.com:org/repo.
    /^[^\s/@]+@[^\s/:]+:/.test(value) ||
    // In dependency position, a URL on a git host is a clone address, never a registry download.
    /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(value) ||
    // user/repo shorthand. Local paths (./lib, ../shared, /abs/path) wear the same two-part
    // shape but name files on this machine, so they never count as shorthand.
    (!value.startsWith('./') &&
      !value.startsWith('../') &&
      !value.startsWith('/') &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]+)?$/.test(value))
  );
}

/**
 * Git-address specs inside an overrides object, whose values may nest one package's spec under
 * another package's entry. Returns the same "name: spec" shape as a plain dependency hit.
 */
function findGitSpecInOverrides(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string' && isGitSpec(spec)) {
      return `${name}: ${spec}`;
    }
    const nested = findGitSpecInOverrides(spec);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/** Git-address dependencies in package.json, read structurally so homepage and repository links never match. */
function findPackageJsonGitDependency(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...parsed };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = record[field];
    if (typeof deps !== 'object' || deps === null) {
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && isGitSpec(spec)) {
        return `${name}: ${spec}`;
      }
    }
  }
  // npm overrides, yarn resolutions and pnpm overrides carry dependency specs too, and a git
  // address hidden there would be fetched exactly like one in the plain dependency lists.
  const overrideSources: unknown[] = [record['overrides'], record['resolutions']];
  const pnpm = record['pnpm'];
  if (typeof pnpm === 'object' && pnpm !== null) {
    const pnpmRecord: Record<string, unknown> = { ...pnpm };
    overrideSources.push(pnpmRecord['overrides']);
  }
  for (const source of overrideSources) {
    const hit = findGitSpecInOverrides(source);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Flags whose next word is a setting value, per package family: an index or registry address, a
 * file to read, a folder to write to. Those values are settings, not package specs, so the word
 * after one is never judged as a spec. pip's -e and --editable are absent on purpose: the word
 * after them is a spec. Cargo's --git is absent for the same reason.
 */
const FLAG_VALUE_WORDS: Record<PackageDownloadEcosystem, ReadonlySet<string>> = {
  pypi: new Set([
    '--index-url',
    '--extra-index-url',
    '--default-index',
    '--index',
    '--find-links',
    '--proxy',
    '--requirement',
    '--constraint',
    '--target',
    '--prefix',
    '--root',
    '--cache-dir',
    '--src',
    '--cert',
    '--client-cert',
    '--trusted-host',
    '--python-version',
    '--platform',
    '--abi',
    '--implementation',
    '--global-option',
    '--install-option',
    '--report',
    '--python',
    '--keyring-provider',
    '--progress-bar',
    '--dest',
    '--group',
    '--source',
    '-i',
    '-r',
    '-c',
    '-f',
    '-t',
    '-d',
  ]),
  npm: new Set([
    '--registry',
    '--proxy',
    '--https-proxy',
    '--prefix',
    '--cache',
    '--userconfig',
    '--globalconfig',
    '--workspace',
    '--tag',
    '--otp',
    '--loglevel',
    '--logdir',
    '--init-module',
    '-w',
  ]),
  go: new Set([
    '-C',
    '-mod',
    '-modfile',
    '-tags',
    '-ldflags',
    '-gcflags',
    '-asmflags',
    '-toolexec',
    '-o',
    '-exec',
    '-run',
    '-count',
    '-timeout',
    '-bench',
    '-benchtime',
    '-coverprofile',
    '-output',
  ]),
  cargo: new Set([
    '--registry',
    '--index',
    '--manifest-path',
    '--target',
    '--path',
    '--features',
    '--package',
    '--color',
    '--config',
    '-F',
    '-p',
  ]),
  any: new Set<string>(),
};

/**
 * Flags whose value is a package spec rather than a setting, per package family: pip's editable
 * flag names the package to install. Such a value is judged as a spec however it reaches the
 * flag: as the next word, after an equals sign, or stuck onto the short flag itself.
 */
const SPEC_VALUE_FLAGS: Record<PackageDownloadEcosystem, ReadonlySet<string>> = {
  pypi: new Set(['-e', '--editable']),
  npm: new Set<string>(),
  go: new Set<string>(),
  cargo: new Set<string>(),
  any: new Set<string>(),
};

/**
 * The package spec a flag carries inside its own word, or undefined: the value after an equals
 * sign on a spec flag (--editable=git+https://...), or the value stuck onto a short spec flag
 * (-egit+...). A flag whose value is a setting never unpacks, so its value stays unjudged.
 */
function attachedSpecValue(word: string, specFlags: ReadonlySet<string>): string | undefined {
  const equals = word.indexOf('=');
  if (equals !== -1) {
    return specFlags.has(word.slice(0, equals)) ? word.slice(equals + 1) : undefined;
  }
  if (!word.startsWith('--') && word.length > 2) {
    return specFlags.has(word.slice(0, 2)) ? word.slice(2) : undefined;
  }
  return undefined;
}

/**
 * Whether one word from a download command's own argument list names a package the mirrors
 * cannot serve: the same specs the manifest checks refuse, plus a bare web address, which as a
 * command argument is a direct download the mirrors would never see.
 */
function isRefusedCommandSpec(word: string): boolean {
  if (isGitSpec(word) || GIT_SPEC_PATTERNS.some(pattern => pattern.test(word))) {
    return true;
  }
  return /^https?:\/\//i.test(word);
}

/**
 * The first package spec on a download command's own argument list that the mirrors cannot
 * serve, or undefined. A manifest is not the only place such a spec can hide: one typed
 * straight into the command would be fetched by the tool itself, around the mirrors. Only
 * download commands are read, and only their package words: flag spellings are skipped, and
 * so is the value of a flag that takes one, because a setting is not a package. A spec flag's
 * attached value is read as a word of its own, because it names the package itself.
 */
export function findCommandLineGitDependency(command: string): string | undefined {
  for (const { ecosystem, argv } of downloadCommands(command)) {
    const valueWords = FLAG_VALUE_WORDS[ecosystem];
    const specWords = SPEC_VALUE_FLAGS[ecosystem];
    let skipNext = false;
    let positionalOnly = false;
    for (const word of argv.slice(1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!positionalOnly && word === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && word.startsWith('-')) {
        const attached = attachedSpecValue(word, specWords);
        if (attached !== undefined) {
          if (isRefusedCommandSpec(attached)) {
            return attached;
          }
        } else if (!word.includes('=') && valueWords.has(word)) {
          skipNext = true;
        }
        continue;
      }
      if (isRefusedCommandSpec(word)) {
        return word;
      }
    }
  }
  return undefined;
}

/**
 * The first git-address dependency in the given manifest contents, or undefined. `file` in the result
 * is the manifest's own name, so a message can say where the dependency was found.
 */
export function findGitDependency(
  manifests: readonly { name: string; content: string }[],
): { file: string; line: string } | undefined {
  for (const manifest of manifests) {
    if (manifest.name === 'package.json') {
      const hit = findPackageJsonGitDependency(manifest.content);
      if (hit !== undefined) {
        return { file: manifest.name, line: hit };
      }
      continue;
    }
    for (const rawLine of manifest.content.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }
      if (GIT_SPEC_PATTERNS.some(pattern => pattern.test(line))) {
        return { file: manifest.name, line };
      }
    }
  }
  return undefined;
}
