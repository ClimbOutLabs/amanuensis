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

/** Shell words that end one command and start another. */
const SEGMENT_BREAKS = new Set(['&&', '||', ';', '|', '&', '\n']);

/**
 * Splits a shell command into simple commands as word lists. Deliberately small: quotes are honoured,
 * everything else (subshells, substitutions) stays inside its segment as words. The callers only use
 * this to recognise package tool invocations, and a miss fails safe: the command runs with no mirror
 * grant attached, exactly as it did before mirrors existed.
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

/** Leading words that do not change which program runs: env assignments, sudo, env, npx-style runners. */
function programWords(words: string[]): string[] {
  let index = 0;
  for (;;) {
    const word = words[index];
    if (word === undefined) {
      return [];
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'sudo' || word === 'env') {
      index += 1;
      continue;
    }
    return words.slice(index);
  }
}

const PIP_PROGRAMS = new Set(['pip', 'pip3']);
const NPM_PROGRAMS = new Set(['npm', 'pnpm', 'yarn']);

/** The package family one simple command downloads from, named by its mirror. */
type PackageDownloadEcosystem = 'pypi' | 'npm' | 'go' | 'cargo';

/** How each package site is named in words a person reads. */
const PACKAGE_SITE_NAMES: Record<PackageDownloadEcosystem, string> = {
  pypi: 'PyPI',
  npm: 'npm',
  go: 'the Go package site',
  cargo: 'crates.io',
};

/** The ecosystem one simple command downloads packages from, or undefined when it downloads none. */
function segmentDownloadEcosystem(argv: string[]): PackageDownloadEcosystem | undefined {
  const program = argv[0];
  if (program === undefined) {
    return undefined;
  }
  const base = program.slice(program.lastIndexOf('/') + 1);
  const sub = argv[1];
  if (PIP_PROGRAMS.has(base) && sub === 'install') {
    return 'pypi';
  }
  if ((base === 'python' || base === 'python3') && argv[1] === '-m' && argv[2] === 'pip' && argv[3] === 'install') {
    return 'pypi';
  }
  if (
    NPM_PROGRAMS.has(base) &&
    (sub === 'install' || sub === 'i' || sub === 'ci' || sub === 'add' || sub === 'update')
  ) {
    return 'npm';
  }
  if (base === 'npx' && argv[1] === 'npm' && (argv[2] === 'install' || argv[2] === 'ci')) {
    return 'npm';
  }
  if (
    base === 'cargo' &&
    (sub === 'build' ||
      sub === 'test' ||
      sub === 'run' ||
      sub === 'check' ||
      sub === 'clippy' ||
      sub === 'fetch' ||
      sub === 'update' ||
      sub === 'add')
  ) {
    return 'cargo';
  }
  if (
    base === 'go' &&
    (sub === 'build' || sub === 'test' || sub === 'run' || sub === 'get' || sub === 'install' || sub === 'vet')
  ) {
    return 'go';
  }
  if (base === 'go' && sub === 'mod' && (argv[2] === 'download' || argv[2] === 'tidy' || argv[2] === 'vendor')) {
    return 'go';
  }
  if (
    (base === 'uv' && sub === 'pip' && argv[2] === 'install') ||
    (base === 'uv' && (sub === 'sync' || sub === 'add'))
  ) {
    return 'pypi';
  }
  if (base === 'poetry' && (sub === 'install' || sub === 'add' || sub === 'update')) {
    return 'pypi';
  }
  return undefined;
}

/**
 * Whether a command would make a package tool download packages: installs, and the build and test
 * commands that fetch dependencies first. Only these commands get the git-address check, because only
 * they would try to fetch the dependency.
 */
export function commandDownloadsPackages(command: string): boolean {
  return splitShellCommands(command).some(words => segmentDownloadEcosystem(programWords(words)) !== undefined);
}

/**
 * The one sentence the first-download approval card shows, or undefined when the command downloads
 * nothing. The sites are named for the tools this command actually uses, in the order it uses them.
 */
export function packageDownloadCardWhat(command: string): string | undefined {
  const sites: string[] = [];
  for (const words of splitShellCommands(command)) {
    const ecosystem = segmentDownloadEcosystem(programWords(words));
    if (ecosystem !== undefined) {
      const name = PACKAGE_SITE_NAMES[ecosystem];
      if (!sites.includes(name)) {
        sites.push(name);
      }
    }
  }
  if (sites.length === 0) {
    return undefined;
  }
  return `Aman wants to download this project's packages from the public package sites (${sites.join(', ')}).`;
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
  for (const words of splitShellCommands(command)) {
    const argv = programWords(words);
    const ecosystem = segmentDownloadEcosystem(argv);
    if (ecosystem === undefined) {
      continue;
    }
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
