# Feature Specs

This directory holds feature specifications for Amanuensis. We practice Spec-Driven Development: every nontrivial feature starts here as a written spec before any code is written.

## Rules

1. **Spec first.** No implementation begins until the spec is written and approved.
2. **Approval required.** Each spec must be reviewed and approved (by Sidd) before coding starts. A spec without approval is a draft, not a plan.
3. **Concise.** Specs describe the problem, the solution, key design decisions, scope, privacy implications, testing approach, and out-of-scope items. They are not implementation plans.
4. **Privacy section is mandatory.** Every spec must address privacy: what data is involved, where it flows, and what stays on the device.
5. **Testing uses synthetic data.** Specs must state that tests use synthetic data, never the user's real data.

## Lifecycle

- `draft` - written, awaiting review
- `approved` - reviewed and approved, ready for implementation
- `implemented` - the feature has landed; the spec stays as documentation

Mark the status at the top of each spec file.

## Related

- Implementation PRs must link their spec (see `.github/pull_request_template.md`).
- Feature requests that have not been spec'd yet live outside this directory.
