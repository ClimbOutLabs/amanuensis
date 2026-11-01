#!/usr/bin/env node
/**
 * Fails when any third-party dependency lacks a license on the accepted list
 * in scripts/dependency-license-policy.mjs. Reads every way the repo pulls in
 * dependencies:
 * - the pnpm workspace, from the installed tree (run `pnpm install` first)
 * - standalone npm projects, from each tracked package-lock.json
 * - Python, from each tracked requirements*.txt / requirements*.lock, which
 *   must pin every package exactly; license data comes from PyPI for that
 *   version
 * - Go, from each tracked go.mod
 * Dockerfiles must install packages from those files rather than by name, and
 * Python packaging manifests (pyproject.toml, setup.py, setup.cfg) are not
 * read, so tracking one fails. OS packages from apt are out of scope.
 *
 * A package whose license metadata is missing or unclear can be listed in
 * scripts/dependency-licenses-reviewed.txt with the SPDX license a person read
 * in its license text. That license must still be on the accepted list, and
 * the entry is refused when the package's own metadata names a license.
 *
 * Usage: node scripts/check-dependency-licenses.mjs
 * Exit 0 when clean, 1 with one line per problem otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseProblem, reviewedEntryProblem } from './dependency-license-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const REVIEWED_PATH = join(here, 'dependency-licenses-reviewed.txt');
const PYPI = 'https://pypi.org/pypi';

class CheckError extends Error {}

function run(cmd, args, { what, next }) {
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (caught) {
    throw new CheckError(`Could not ${what}. ${next}`, { cause: caught });
  }
}

function trackedFiles(...patterns) {
  const out = run('git', ['ls-files', '-z', '--', ...patterns], {
    what: 'list the files in this repository',
    next: 'Run the check from inside the repository.',
  });
  return out.split('\0').filter(Boolean);
}

/** `ecosystem:name@version` -> SPDX expression, from the reviewed file. */
function readReviewed() {
  const reviewed = new Map();
  for (const [index, raw] of readFileSync(REVIEWED_PATH, 'utf8').split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const [key, expression, source] = line.split('::').map(part => part.trim());
    if (!key || !expression || !source) {
      throw new CheckError(
        `Line ${index + 1} of ${REVIEWED_PATH} is not "package :: license :: where it was checked". Fix that line.`,
      );
    }
    reviewed.set(key, expression);
  }
  return reviewed;
}

function pnpmPackages() {
  const out = run('pnpm', ['licenses', 'list', '--recursive', '--json'], {
    what: 'list the pnpm workspace packages',
    next: 'Run `pnpm install`, then run this check again.',
  });
  return Object.values(JSON.parse(out))
    .flat()
    .flatMap(pkg =>
      pkg.versions.map(version => ({
        key: `npm:${pkg.name}@${version}`,
        source: 'pnpm workspace',
        statements: pkg.license && pkg.license !== 'Unknown' ? [pkg.license] : [],
      })),
    );
}

function npmLockPackages(lockPath) {
  const lock = JSON.parse(readFileSync(join(root, lockPath), 'utf8'));
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path !== '' && !entry.link)
    .map(([path, entry]) => ({
      key: `npm:${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`,
      source: lockPath,
      statements: entry.license ? [entry.license] : [],
    }));
}

/** Requirement lines with continuations joined and comments and options dropped. */
function requirementLines(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(line => line !== '' && !line.startsWith('-'));
}

const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;]+)/;

/** Exact pins of a requirements file, or the lines that are not pinned exactly. */
function pythonPins(requirementsPath) {
  const lines = requirementLines(readFileSync(join(root, requirementsPath), 'utf8'));
  const unpinned = lines.filter(line => !PIN.test(line));
  if (unpinned.length > 0) {
    return { pins: [], unpinned };
  }
  return { pins: lines.map(line => line.match(PIN)).map(([, name, version]) => ({ name, version })), unpinned };
}

/** License statements of one PyPI release, most authoritative first. */
async function pypiStatements({ name, version }) {
  const response = await fetch(`${PYPI}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
  if (!response.ok) {
    throw new CheckError(
      `Could not read ${name} ${version} from PyPI (HTTP ${response.status}). Check the network and the pinned version, then run this check again.`,
    );
  }
  const { info } = await response.json();
  if (info.license_expression) {
    return [info.license_expression];
  }
  const classifiers = (info.classifiers ?? []).filter(
    c => c.startsWith('License ::') && c !== 'License :: OSI Approved',
  );
  if (classifiers.length > 0) {
    return classifiers;
  }
  // A multi-line license field is the license document itself, not its name.
  const field = (info.license ?? '').trim();
  return field !== '' && !field.includes('\n') ? [field] : [];
}

async function pythonPackages({ requirementsPaths, problems }) {
  const releases = new Map();
  for (const path of requirementsPaths) {
    const { pins, unpinned } = pythonPins(path);
    if (unpinned.length > 0) {
      problems.push(
        `- ${path} does not pin ${unpinned.join(', ')} to one version. Lock it with \`uv pip compile\` (keep the ranges in a .in file) so the check reads exactly what installs.`,
      );
    }
    for (const pin of pins) {
      const key = `pypi:${pin.name.toLowerCase().replace(/[._-]+/g, '-')}@${pin.version}`;
      if (!releases.has(key)) {
        releases.set(key, { key, source: path, pin });
      }
    }
  }
  return Promise.all(
    [...releases.values()].map(async ({ key, source, pin }) => ({
      key,
      source,
      statements: await pypiStatements(pin),
    })),
  );
}

/** Go modules carry no license metadata, so each one needs a reviewed entry. */
function goPackages(goModPath) {
  const text = readFileSync(join(root, goModPath), 'utf8').replace(/\/\/.*$/gm, '');
  const requires = [...text.matchAll(/^\s*require\s*\(([^)]*)\)/gm)].flatMap(m => m[1].split('\n'));
  requires.push(...[...text.matchAll(/^\s*require\s+([^(\s].*)$/gm)].map(m => m[1]));
  return requires
    .map(line => line.trim().split(/\s+/))
    .filter(([module, version]) => module && version)
    .map(([module, version]) => ({ key: `go:${module}@${version}`, source: goModPath, statements: [] }));
}

// Package installs by name in a Dockerfile bypass every manifest this check reads.
const NAMED_INSTALLS = [
  { pattern: /\b(?:pip[0-9.]*|pipx|uv\s+pip|uv\s+tool)\s+install\s+([^&|;\n]*)/g, tool: 'pip' },
  { pattern: /\bnpm\s+(?:install|i|add)\s+([^&|;\n]*)/g, tool: 'npm' },
  { pattern: /\b(?:pnpm|yarn)\s+(?:global\s+)?add\s+([^&|;\n]*)/g, tool: 'pnpm/yarn' },
  { pattern: /\bgo\s+install\s+([^&|;\n]*)/g, tool: 'go' },
  { pattern: /\bcargo\s+install\s+([^&|;\n]*)/g, tool: 'cargo' },
  { pattern: /\bgem\s+install\s+([^&|;\n]*)/g, tool: 'gem' },
];

/** Names of the npm packages this repository publishes. */
function workspacePackageNames() {
  return new Set(
    trackedFiles('*package.json')
      .map(path => JSON.parse(readFileSync(join(root, path), 'utf8')).name)
      .filter(name => typeof name === 'string'),
  );
}

/** A package argument without quotes or a version suffix (`name@1.2.3` -> `name`). */
function packageName(arg) {
  const bare = arg.replace(/^["']|["']$/g, '');
  const at = bare.lastIndexOf('@');
  return at > 0 ? bare.slice(0, at) : bare;
}

/**
 * Dockerfile commands that install packages by name instead of from a checked
 * file. Installing a package this repository publishes is fine: its
 * dependencies are the workspace's, which the pnpm check already reads.
 */
function namedInstalls() {
  const problems = [];
  const ownPackages = workspacePackageNames();
  for (const path of trackedFiles('*Dockerfile*', '*.dockerfile')) {
    const text = readFileSync(join(root, path), 'utf8')
      .replace(/\\\r?\n/g, ' ')
      .replace(/^\s*#.*$/gm, '');
    for (const { pattern, tool } of NAMED_INSTALLS) {
      for (const match of text.matchAll(pattern)) {
        const args = match[1].split(/\s+/).filter(Boolean);
        const usesFile = args.some(a => a === '-r' || a.startsWith('--requirement') || /^-r\S/.test(a));
        const packages = args.filter(
          a =>
            !a.startsWith('-') &&
            !a.startsWith('/') &&
            !a.startsWith('.') &&
            !(tool === 'npm' && ownPackages.has(packageName(a))),
        );
        const onlyPip = tool === 'pip' && packages.every(p => p === 'pip');
        if (!usesFile && !onlyPip && packages.length > 0) {
          problems.push(
            `- ${path} installs packages by name with ${tool} (${packages.join(' ')}). Install them from a lockfile or pinned requirements file this check reads.`,
          );
        }
      }
    }
  }
  return problems;
}

/** Python packaging manifests, whose dependencies this check does not read. */
function packagingManifests() {
  return trackedFiles('*pyproject.toml', '*setup.cfg', '*setup.py')
    .filter(path => {
      const text = readFileSync(join(root, path), 'utf8');
      return path.endsWith('setup.py')
        ? /\b(?:setuptools|distutils)\b/.test(text)
        : path.endsWith('setup.cfg') || /^\[(?:project|tool\.poetry)/m.test(text);
    })
    .map(
      path =>
        `- ${path} declares Python dependencies, which this check does not read. Install them from a pinned requirements file instead.`,
    );
}

async function main() {
  if (!existsSync(join(root, 'node_modules'))) {
    throw new CheckError('Dependencies are not installed. Run `pnpm install`, then run this check again.');
  }
  const reviewed = readReviewed();
  const problems = [...namedInstalls(), ...packagingManifests()];
  const packages = [
    ...pnpmPackages(),
    ...trackedFiles('*package-lock.json').flatMap(npmLockPackages),
    ...(await pythonPackages({
      requirementsPaths: trackedFiles('*requirements*.txt', '*requirements*.lock'),
      problems,
    })),
    ...trackedFiles('*go.mod').flatMap(goPackages),
  ];

  const used = new Set();
  for (const pkg of packages) {
    let statements = pkg.statements;
    if (reviewed.has(pkg.key)) {
      used.add(pkg.key);
      const refused = reviewedEntryProblem(pkg.statements);
      if (refused) {
        problems.push(`- ${pkg.key} (${pkg.source}) ${refused}.`);
      } else {
        statements = [reviewed.get(pkg.key)];
      }
    }
    const problem = licenseProblem(statements);
    if (problem) {
      problems.push(`- ${pkg.key} (${pkg.source}) ${problem}`);
    }
  }
  for (const key of reviewed.keys()) {
    if (!used.has(key)) {
      problems.push(
        `- ${key} is listed in scripts/dependency-licenses-reviewed.txt but is no longer a dependency. Remove that line.`,
      );
    }
  }

  if (problems.length === 0) {
    console.log(`Checked ${packages.length} dependencies: every license is on the accepted list.`);
    return;
  }
  console.error(`${problems.length} dependency license problem(s):\n`);
  console.error([...new Set(problems)].join('\n'));
  console.error(
    '\nReplace each dependency with one under an accepted license. If its metadata is only missing or unclear, read its license text and add it to scripts/dependency-licenses-reviewed.txt.',
  );
  process.exitCode = 1;
}

main().catch(error => {
  if (error instanceof CheckError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
});
