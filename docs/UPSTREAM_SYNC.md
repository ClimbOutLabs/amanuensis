# Upstream sync

How this fork continuously absorbs truefoundry/trueforge. The goal is a
small, boring merge on a cadence instead of a crisis twice a year.

## Ground rules

1. **The ancestry marker must exist before any merge.** The fork was
   flattened into a single root commit, so plain merging is impossible until
   a one-time marker merge (`git merge -s ours --allow-unrelated-histories
d421135d`) lands on main, recording that we contain upstream up to the
   fork point. It changes zero bytes of the tree.
2. **Sync PRs merge with a merge commit. Never squash.** Squashing flattens
   the merge and severs the upstream ancestry again, recreating the original
   disease. This applies to the marker PR and to every sync PR.
3. **Generated artifacts are never hand-merged.** SDK, OpenAPI documents,
   and the lockfile are taken as ours during the merge and regenerated from
   the merged source afterwards.
4. **DIVERGENCE.md is the conflict map.** Every deliberate deviation from an
   upstream file is listed there with its resolution policy. Consult it
   before resolving; update it in the same PR when a sync adds or removes a
   deviation. Files not listed default to upstream-wins.
5. **`decide` entries block the merge.** A file marked `decide` (for example
   the compaction-trigger overlap) means an architectural decision is
   pending; get it settled with the owning agent before resolving, never in
   the diff editor.

## Cadence

Weekly, plus on demand before starting large local features that touch
upstream surfaces. The scheduled workflow
(.github/workflows/upstream-sync.yml) checks drift every Monday and opens a
draft PR when the merge is clean, or an issue with the conflict manifest
when it is not. Small and often beats big and rare.

## One-time setup (per clone)

```bash
git remote add upstream https://github.com/truefoundry/trueforge.git
git remote set-url --push upstream DISABLED
gh repo set-default <your-fork>
```

The last line is load-bearing. The gh CLI resolves repositories from git
remotes and prefers the one literally named `upstream`, so once that remote
exists, any bare `gh` command (comment, PR, issue) in a clone without a
pinned default silently targets the public repository. The disabled push
URL does not protect against this: gh talks to the GitHub API, never the
push URL.

## Procedure

```bash
pnpm run sync:check
```

Reports how many commits upstream is ahead and whether the ancestry marker
is present on origin/main. Then:

```bash
pnpm run sync:start
```

Creates `sync/upstream-<date>` from origin/main (never from whatever branch
happens to be checked out), merges `upstream/main`, auto-resolves every
`regenerate` path to ours (placeholder until regeneration), and prints the
remaining conflicts grouped by their DIVERGENCE.md policy. If a branch for
that upstream date already exists locally or on origin, the script refuses
and tells you to resume it instead; it never resets in-progress sync work.
The scheduled workflow applies the same rule: while a sync PR is open, its
branch is never recreated or force-pushed.

Then by hand:

1. Resolve `ours` and `merge` conflicts per the ledger. Stop and coordinate
   on any `decide` entry.
2. Regenerate: `pnpm install` (lockfile), then `pnpm sdk:generate` on Linux
   (Windows: the WSL pipeline documented in the team memory; the script
   refuses to produce incomplete output). Commit the regenerated artifacts.
3. If upstream bumped `@truefoundry/assistant-ui-runtime`, re-create the
   pnpm patch against the new version and verify the patched behaviors.
4. Run the full gate: the pre-push hook runs the entire verify (scan,
   format, typecheck, lint, build, every test suite). The memory, autonomy,
   and connector tests are the fork's tripwires; a sync that breaks them
   fails here, not in chat.
5. Push, open the PR titled `sync: upstream <short-sha> (<date>)` with the
   conflict list and how each was resolved. Cross-review (the agent that did
   not drive the sync reviews it). Merge with a merge commit.
6. Rebuild running deployments from main afterwards; verify feature markers
   inside the image before swapping containers.

## Public release

After each sync PR merges into main, the updated tree is published to the public
repository as a single squashed commit with private material removed. See
docs/PUBLIC_RELEASE.md for the manifest, rewrite rules, and export command.
The public history is one commit per sync by design; there are no branches or
history visible to the public.
