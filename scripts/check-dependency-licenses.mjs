#!/usr/bin/env node
/**
 * Fails when any third-party dependency carries a strong or network copyleft
 * license (see scripts/dependency-license-policy.mjs). Covers every package
 * manager the repo ships dependencies through:
 * - the pnpm workspace, read from the installed tree (run `pnpm install` first)
 * - standalone npm projects, read from each tracked package-lock.json
 * - Python, by resolving each tracked requirements*.txt with pip (25 or newer)
 *
 * Usage: node scripts/check-dependency-licenses.mjs
 * Exit 0 when clean, 1 with one line per offending package otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseProblem } from './dependency-license-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_PIP_MAJOR = 25; // older pip leaves License-Expression out of its install report

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

function trackedFiles(pattern) {
  return run('git', ['ls-files', '-z', '--', pattern]).split('\0').filter(Boolean);
}

/** README and license text a package ships, or null when it ships none. */
function shippedText(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(readme|license|licence|copying)/i.test(entry.name))
    .map(entry => entry.name);
  const text = names.map(n => readFileSync(join(dir, n), 'utf8')).join('\n');
  return text.length > 0 ? text : null;
}

function pnpmPackages() {
  const byLicense = JSON.parse(run('pnpm', ['licenses', 'list', '--recursive', '--json']));
  return Object.values(byLicense)
    .flat()
    .map(pkg => {
      const declared = pkg.license && pkg.license !== 'Unknown' ? [pkg.license] : [];
      return {
        source: 'pnpm workspace',
        name: `${pkg.name}@${pkg.versions.join(', ')}`,
        declared,
        shippedText: declared.length > 0 ? null : shippedText(pkg.paths[0]),
      };
    });
}

function npmLockPackages(lockPath) {
  const lock = JSON.parse(readFileSync(join(root, lockPath), 'utf8'));
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path !== '' && !entry.link)
    .map(([path, entry]) => ({
      source: lockPath,
      name: `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`,
      declared: entry.license ? [entry.license] : [],
      shippedText: null,
    }));
}

function pipMajor() {
  const match = run('python3', ['-m', 'pip', '--version']).match(/^pip (\d+)\./);
  return match ? Number(match[1]) : 0;
}

function pythonPackages(requirementsPath) {
  const dir = mkdtempSync(join(tmpdir(), 'license-check-'));
  const report = join(dir, 'report.json');
  try {
    run(
      'python3',
      [
        '-m',
        'pip',
        'install',
        '--dry-run',
        '--ignore-installed',
        '--quiet',
        '--report',
        report,
        '-r',
        requirementsPath,
      ],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    const { install } = JSON.parse(readFileSync(report, 'utf8'));
    return install.map(({ metadata }) => {
      const classifiers = (metadata.classifier ?? [])
        .filter(c => c.startsWith('License ::'))
        .map(c => c.split('::').at(-1).trim());
      // Most to least authoritative: the SPDX expression, trove classifiers,
      // then a one-line license field. A multi-line license field is the full
      // license document, which lists bundled third-party notices, so it is
      // read as shipped text instead.
      const licenseField = (metadata.license ?? '').trim();
      const oneLine = licenseField !== '' && !licenseField.includes('\n');
      const declared = metadata.license_expression
        ? [metadata.license_expression]
        : classifiers.length > 0
          ? classifiers
          : oneLine
            ? [licenseField]
            : [];
      const text = [oneLine ? '' : licenseField, metadata.description ?? ''].join('\n').trim();
      return {
        source: requirementsPath,
        name: `${metadata.name}@${metadata.version}`,
        declared,
        shippedText: text || null,
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  if (!existsSync(join(root, 'node_modules'))) {
    console.error('Dependencies are not installed. Run `pnpm install`, then run this check again.');
    process.exit(1);
  }
  const requirements = trackedFiles('*requirements*.txt');
  if (requirements.length > 0 && pipMajor() < MIN_PIP_MAJOR) {
    console.error(
      `This check needs pip ${MIN_PIP_MAJOR} or newer. Run \`python3 -m pip install --upgrade pip\`, then run it again.`,
    );
    process.exit(1);
  }

  const packages = [
    ...pnpmPackages(),
    ...trackedFiles('*package-lock.json').flatMap(npmLockPackages),
    ...requirements.flatMap(pythonPackages),
  ];
  const problems = packages
    .map(pkg => ({ pkg, problem: licenseProblem(pkg) }))
    .filter(({ problem }) => problem !== null);

  if (problems.length === 0) {
    console.log(`Checked ${packages.length} dependencies: no copyleft licenses.`);
    return;
  }
  console.error('These dependencies have licenses Aman cannot ship under MPL-2.0:\n');
  for (const { pkg, problem } of problems) {
    console.error(`- ${pkg.name} (${pkg.source}) ${problem}`);
  }
  console.error('\nReplace each one with a dependency under a permissive or weak copyleft license.');
  process.exit(1);
}

main();
