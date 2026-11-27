# Spec: Keep source files small

**Status:** approved

## Problem

A handful of central source files grew far past what a reviewer can hold in mind: the sandbox tools file is 8,000 lines and the agent loop is 6,670. Nothing stopped a file from growing, so each new feature added to whichever file already held its neighbours.

## Solution

1. A check, `scripts/check-file-sizes.mjs` (`pnpm check:file-sizes`), fails when a source file is longer than 1,000 lines. It runs in CI's Repository layout rules job, which needs no install.
2. Files that were already over the limit are listed in `scripts/file-size-baseline.json` with their length when the check arrived. Each may not grow past its listed length. Shrinking always passes with no edit to the list, and the check prints a note. A separate tidy, `pnpm check:file-sizes --update` in its own small PR, lowers the numbers and drops files that fit under the limit. It never raises a number or adds a file.
3. `AGENTS.md` and `CONTRIBUTING.md` state the rule.

## Design decisions

- **Checked:** tracked `.js`, `.jsx`, `.ts`, `.tsx` (and their `c`/`m` forms) and `.py` files.
- **Not checked:** tests and their fixtures, generated code (the SDK, `*.generated.*`, `.d.ts`), and vendored code (`mcp/gmail`, `vendor/` folders). None of it is ours to split.
- **1,000 lines:** below the next-largest files, and room for a module that does one job. Splits planned for the largest files fit under it.
- **A ratchet with a separate tidy:** only growth fails. If shrinking also required a baseline edit, every pull request that shortens a big file would edit the same list and parallel pull requests would conflict on it. Between tidies a file that shrank may grow back up to its listed length; the tidy closes that gap.
- **Growth in a listed file:** new code goes in its own file. Raising a listed number by hand needs a reason in the PR description.
- **Moving a listed file:** its entry moves with it in the same change.

## Privacy

The check reads source code only. No personal data is involved.

## Testing

`tests/file-sizes.test.mjs` (run by `pnpm test:repo-policy`) covers line counting, which files are checked, a new file over the limit, a listed file growing (fails), and shrinking, dropping under the limit or being deleted (all pass, and the tidy updates the list).

## Out of scope

- Limits on function length or branching. A later change can add them once the largest files are split.
- Splitting any file. That is separate work.
