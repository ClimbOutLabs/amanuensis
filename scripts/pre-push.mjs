import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges, pushedHeadFromInput, readGitVisibleWorktreeChanges } from './pre-push-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error('pre-push must be invoked through `pnpm run pre-push`');
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function runPnpm(args) {
  const display = ['pnpm', ...args].join(' ');
  console.log(`\n$ ${display}`);
  const result = spawnSync(process.execPath, [pnpmCli, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runBroaderChecks() {
  runPnpm(['format:check']);
  runPnpm(['typecheck']);
  runPnpm(['lint:ci']);
}

function readChangedFiles(target) {
  try {
    git(['rev-parse', '--verify', 'origin/main^{commit}']);
  } catch {
    console.error('pre-push: origin/main is unavailable; fetch it before pushing so checks can be scoped safely.');
    process.exit(1);
  }

  const output = git(['diff', '--name-only', '-z', `origin/main...${target}`]);
  return output ? output.split('\0').filter(Boolean) : [];
}

function selectedPackages() {
  const output = execFileSync(
    process.execPath,
    [pnpmCli, '--filter', '...[origin/main]', 'list', '--depth', '-1', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  const entries = JSON.parse(output);
  return entries
    .filter(entry => typeof entry.path === 'string' && resolve(entry.path) !== root)
    .map(entry => {
      const packageJsonPath = join(entry.path, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return {
        name: packageJson.name,
        path: entry.path,
        directory: relative(root, entry.path).split(/[\\/]/)[1],
        scripts: packageJson.scripts ?? {},
      };
    })
    .filter(entry => entry.name && relative(root, entry.path).split(/[\\/]/)[0] === 'packages');
}

function runChangedPackageTypechecks(changed) {
  let packages;
  try {
    packages = selectedPackages();
  } catch (error) {
    console.error('pre-push: changed-package selection failed; running broader checks instead.');
    console.error(error instanceof Error ? error.message : error);
    runBroaderChecks();
    return;
  }

  const selectedDirectories = new Set(packages.map(packageInfo => packageInfo.directory));
  const missingDirectories = [...changed.packageDirectories].filter(directory => !selectedDirectories.has(directory));
  if (missingDirectories.length > 0) {
    console.error(
      `pre-push: pnpm did not select changed package(s) ${missingDirectories.join(', ')}; running broader checks instead.`,
    );
    runBroaderChecks();
    return;
  }

  for (const packageInfo of packages) {
    if (packageInfo.scripts.typecheck) {
      runPnpm(['--filter', packageInfo.name, 'run', 'typecheck']);
    }
  }
}

function main() {
  const head = git(['rev-parse', 'HEAD']);
  let pushedHead;
  try {
    pushedHead = pushedHeadFromInput({ input: readFileSync(0, 'utf8'), head });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (pushedHead === null) {
    console.log('pre-push: only ref deletions were requested; no code checks are needed.');
    return;
  }

  const changed = classifyChanges(readChangedFiles(pushedHead));
  const dirtyFiles = readGitVisibleWorktreeChanges({ cwd: root });
  if (dirtyFiles.length > 0) {
    console.error(
      `pre-push: Git-visible worktree changes found; commit or stash them, then review before pushing: ${dirtyFiles.join(', ')}`,
    );
    process.exit(1);
  }
  const runBroadChecks = changed.broadChecks;
  console.log(`pre-push: ${changed.files.length} file(s) changed since origin/main.`);

  runPnpm(['run', 'test:private-data', '--tree', pushedHead]);

  const existingFormatFiles = changed.formatFiles.filter(existsSync);
  if (existingFormatFiles.length > 0 && !runBroadChecks) {
    // The scripts already end in `--`; pnpm 11 forwards a literal `--` here, which prettier and eslint
    // would read as a file pattern.
    runPnpm(['run', 'format:check:files', ...existingFormatFiles]);
  }
  const existingLintFiles = changed.lintFiles.filter(existsSync);
  if (existingLintFiles.length > 0 && !runBroadChecks) {
    runPnpm(['run', 'lint:check:files', ...existingLintFiles]);
  }
  if (runBroadChecks) {
    runBroaderChecks();
  } else if (changed.packageDirectories.size > 0) {
    runChangedPackageTypechecks(changed);
  }
  if (changed.prePushPolicy) {
    runPnpm(['test:pre-push']);
  }

  if (
    changed.files.length === 0 ||
    (changed.formatFiles.length === 0 &&
      !runBroadChecks &&
      changed.packageDirectories.size === 0 &&
      !changed.prePushPolicy)
  ) {
    console.log('pre-push: no applicable local checks for the changed files.');
  }
}

main();
