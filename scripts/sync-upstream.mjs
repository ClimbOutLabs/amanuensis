// Upstream sync helper. See docs/UPSTREAM_SYNC.md for the full procedure.
//
//   pnpm run sync:check   drift + ancestry report, no changes
//   pnpm run sync:start   create sync branch from origin/main, merge, triage
//
// The script never resolves a conflict a human (or reviewing agent) should
// see: it only auto-takes "ours" for paths DIVERGENCE.md declares regenerate,
// because those are rebuilt from source after the merge anyway. The sync
// branch is always created from origin/main, never from whatever branch
// happens to be checked out, and an existing sync branch is never reset.
import { execFileSync } from 'node:child_process';
import { exit } from 'node:process';

const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_REF = `${UPSTREAM_REMOTE}/main`;
const BASE_REF = 'origin/main';
const FORK_POINT = 'd421135dcfc802e08655d12c119e18ed715db2ef';

/** Paths whose conflicts are auto-resolved to ours and rebuilt afterwards. */
const REGENERATE_PREFIXES = ['.github/fern/openapi/', 'docs/openapi.json', 'packages/trueforge-sdk/', 'pnpm-lock.yaml'];

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function gitAllowFail(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? error.message ?? error) };
  }
}

function ensureRemotes() {
  const remotes = git(['remote']).split('\n');
  if (!remotes.includes(UPSTREAM_REMOTE)) {
    console.error(`Missing "${UPSTREAM_REMOTE}" remote. Add it first:`);
    console.error('  git remote add upstream https://github.com/truefoundry/trueforge.git');
    console.error('  git remote set-url --push upstream DISABLED');
    console.error('  gh repo set-default <your-fork>');
    console.error('(the last line keeps bare gh commands off the public upstream repo)');
    exit(1);
  }
  git(['fetch', 'origin', '--quiet']);
  git(['fetch', UPSTREAM_REMOTE, '--quiet']);
}

/** The marker must be in origin/main's ancestry, not merely on some local branch. */
function ancestryPresent() {
  return gitAllowFail(['merge-base', BASE_REF, UPSTREAM_REF]).ok;
}

function drift() {
  const base = ancestryPresent() ? git(['merge-base', BASE_REF, UPSTREAM_REF]) : FORK_POINT;
  const ahead = git(['rev-list', '--count', `${base}..${UPSTREAM_REF}`]);
  return { base, ahead: Number(ahead) };
}

function check() {
  ensureRemotes();
  const marker = ancestryPresent();
  const { base, ahead } = drift();
  console.log(
    `ancestry marker: ${marker ? 'present on origin/main' : 'MISSING on origin/main (merge the marker PR first; see docs/UPSTREAM_SYNC.md)'}`,
  );
  console.log(`sync base:       ${base.slice(0, 12)}`);
  console.log(`upstream ahead:  ${ahead} commit(s)`);
  if (!marker) {
    exit(2);
  }
  if (ahead === 0) {
    console.log('Nothing to sync.');
  }
}

function isRegenerable(path) {
  return REGENERATE_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix));
}

function branchExists(branch) {
  const local = gitAllowFail(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const remote = gitAllowFail(['ls-remote', '--exit-code', '--heads', 'origin', branch]).ok;
  return { local, remote };
}

function start() {
  ensureRemotes();
  if (!ancestryPresent()) {
    console.error('Ancestry marker missing on origin/main; run sync:check for instructions.');
    exit(2);
  }
  if (git(['status', '--porcelain'])) {
    console.error('Working tree not clean; commit or stash first.');
    exit(1);
  }
  const { ahead } = drift();
  if (ahead === 0) {
    console.log('Upstream has nothing new.');
    return;
  }
  const date = git(['show', '-s', '--format=%cs', UPSTREAM_REF]);
  const branch = `sync/upstream-${date}`;
  const existing = branchExists(branch);
  if (existing.local || existing.remote) {
    console.error(
      `Branch ${branch} already exists (${existing.local ? 'locally' : ''}${existing.local && existing.remote ? ' and ' : ''}${existing.remote ? 'on origin' : ''}).`,
    );
    console.error('A sync for this upstream state is already in progress. Resume it:');
    console.error(`  git checkout ${branch}`);
    console.error('or delete it first if it is truly abandoned. This script never resets an existing sync branch.');
    exit(1);
  }
  git(['checkout', '-b', branch, BASE_REF]);
  console.log(`On ${branch} (from ${BASE_REF}); merging ${UPSTREAM_REF} (${ahead} commits)...`);

  const merge = gitAllowFail(['merge', '--no-ff', UPSTREAM_REF, '-m', `sync: merge upstream/main (${date})`]);
  if (merge.ok) {
    console.log('Merged cleanly. Now regenerate artifacts and run the full gate (docs/UPSTREAM_SYNC.md steps 2-6).');
    return;
  }

  const conflicts = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  const regen = conflicts.filter(isRegenerable);
  const manual = conflicts.filter(path => !isRegenerable(path));

  for (const path of regen) {
    git(['checkout', '--ours', '--', path]);
    git(['add', '--', path]);
  }

  console.log(`\nAuto-resolved to ours pending regeneration (${regen.length}):`);
  for (const path of regen) {
    console.log(`  regenerate  ${path}`);
  }
  console.log(`\nManual conflicts (${manual.length}) - resolve per DIVERGENCE.md, stop on any "decide" entry:`);
  for (const path of manual) {
    console.log(`  manual      ${path}`);
  }
  console.log('\nWhen resolved: git commit, then regenerate artifacts, then the full gate. See docs/UPSTREAM_SYNC.md.');
}

const mode = process.argv[2];
if (mode === '--check') {
  check();
} else if (mode === '--start') {
  start();
} else {
  console.error('Usage: pnpm run sync:check | pnpm run sync:start');
  exit(1);
}
