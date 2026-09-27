import { execFileSync } from 'node:child_process';

const packagePath = /^packages\/([^/]+)\//;

const broadCheckPaths = [
  /^package\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)tsconfig(?:\.[^/]+)?\.json$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^packages\/[^/]+\/eslint\.config\.[cm]?[jt]s$/,
  /^\.prettier(?:rc(?:\.[^/]+)?|ignore)$/,
  /^patches\//,
  /^\.github\/workflows\//,
  /(^|\/)schemas?\//,
  /(^|\/)[^/]*\.schema\.[cm]?[jt]s$/,
  /(^|\/)openapi(?:\.|\/)/,
];

const formatPath = /\.(?:cjs|css|html|js|json|jsx|md|mjs|ts|tsx)$/;
const lintPath = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/;
const prePushPolicyPaths = [
  /^\.husky\/pre-push$/,
  /^scripts\/pre-push(?:-selection)?\.mjs$/,
  /^tests\/pre-push-selection\.test\.mjs$/,
];

function matchesAny(path, patterns) {
  return patterns.some(pattern => pattern.test(path));
}

function normalizePaths(paths) {
  return paths.map(path => path.replaceAll('\\', '/'));
}

export function readGitVisibleWorktreeChanges({ cwd, env = process.env }) {
  const unstaged = execFileSync('git', ['diff', '--name-only', '-z'], { cwd, env, encoding: 'utf8' });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd, env, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return `${unstaged}\0${staged}\0${untracked}`.split('\0').filter(Boolean);
}

export function pushedHeadFromInput({ input, head }) {
  const lines = input
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return head;
  }

  const pushedOids = new Set();
  for (const line of lines) {
    const fields = line.split(/\s+/u);
    if (fields.length !== 4) {
      throw new Error(`invalid pre-push input: ${line}`);
    }
    const localOid = fields[1];
    if (!/^0+$/u.test(localOid)) {
      pushedOids.add(localOid);
    }
  }
  if (pushedOids.size === 0) {
    return null;
  }
  if (pushedOids.size !== 1 || !pushedOids.has(head)) {
    throw new Error('pre-push only validates the checked-out HEAD; push other refs separately from their worktrees');
  }
  return head;
}

export function classifyChanges(changedFiles, { baseAvailable = true } = {}) {
  const normalizedFiles = normalizePaths(changedFiles);
  const packageDirectories = new Set(
    normalizedFiles.flatMap(file => {
      const match = packagePath.exec(file);
      return match ? [match[1]] : [];
    }),
  );

  return {
    files: normalizedFiles,
    packageDirectories,
    formatFiles: normalizedFiles.filter(file => formatPath.test(file)),
    lintFiles: normalizedFiles.filter(file => lintPath.test(file)),
    broadChecks: !baseAvailable || normalizedFiles.some(file => matchesAny(file, broadCheckPaths)),
    prePushPolicy: normalizedFiles.some(file => matchesAny(file, prePushPolicyPaths)),
  };
}
