# Feature Specs

This directory holds feature specifications for Amanuensis. We practice Spec-Driven Development: every nontrivial feature starts here as a written spec before any code is written.

## Rules

1. **Spec first.** No implementation begins until the spec is written and approved.
2. **Approval required.** Each spec must be reviewed and approved (by the maintainer) before coding starts. A spec without approval is a draft, not a plan.
3. **Concise.** Specs describe the problem, the solution, key design decisions, scope, privacy implications, testing approach, and out-of-scope items. They are not implementation plans.
4. **Privacy section is mandatory.** Every spec must address privacy: what data is involved, where it flows, and what stays on the device.
5. **Testing uses synthetic data.** Specs must state that tests use synthetic data, never the user's real data.

## Every PR links its spec

1. **One shared spec per feature.** Every nontrivial PR, whether a person or a coding agent wrote it, links a spec file under `specs/`. The spec is what the PR template's Spec line asks for. A feature split across several PRs links the same shared spec in each PR, and a PR that fits an existing spec links that spec rather than adding a new one.
2. **Spec on the branch, named after the topic.** If the spec is not in the repo yet, the branch's first commit adds it as `specs/<topic>.md`, named after the topic in plain hyphenated words (for example, `specs/memory-vault.md`). Do not name it after the branch: branch names contain slashes, and this folder is flat.
3. **The spec sets the scope.** The reviewer judges the PR against the spec. Work the spec did not ask for is scope creep and a review finding. Work the spec asked for that the PR did not do is also a finding.
4. **Specs are public.** This repo is public, so a spec holds only what a public reader needs: the problem, the change, and how it is tested. No private notes, internal planning, personal details, or local file paths.

## Lifecycle

- `draft` - written, awaiting review
- `approved` - reviewed and approved, ready for implementation
- `implemented` - the feature has landed; the spec stays as documentation

Mark the status at the top of each spec file.

## Related

- Implementation PRs must link their spec on the Spec line of `.github/pull_request_template.md`.
- Feature requests that have not been spec'd yet live outside this directory.
