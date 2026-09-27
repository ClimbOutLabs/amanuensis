# Specs

This directory holds feature specifications. The spec is the source of truth for a
feature; code is its expression.

## When a spec is required

Any non-trivial feature: multi-session work, more than one contributor (human or
agent), or code where a wrong assumption is expensive to unwind (auth, data
migrations, session state, billing-adjacent logic). Trivial fixes and small
refactors do not need a spec; a clear PR description is enough.

## Lifecycle

1. **Write the spec** (`spec.md`): what to build and why, in user-visible
   behavior. Numbered requirements, concrete examples, explicit out-of-scope,
   testable acceptance criteria.
2. **Review the spec** before any code. The cheapest place to catch a wrong
   assumption.
3. **Write the plan** (`plan.md`): technical approach, files and interfaces
   involved, decisions and trade-offs.
4. **Break into tasks** (`tasks.md`): small implementable units, each with its
   own done criteria.
5. **Implement from a fresh session**, with the spec as context. Clean context
   keeps the implementation focused and avoids the context-death spiral of
   long sessions.
6. **Review the diff against the spec**, not just for code quality. Every
   acceptance criterion must be satisfied; nothing outside the spec's scope
   should have changed.

## Layout

```
specs/
  README.md            # this file
  _template/           # copy for new specs
    spec.md
    plan.md
    tasks.md
  001-attribution-footer/  # example (retrospective)
    spec.md
    plan.md
    tasks.md
  002-.../
```

Name directories `NNN-short-slug`, numbered in creation order. One feature per
spec; split when it gets big and link the pieces.

## Living documents

Specs stay in the repo next to the code they describe. When scope changes,
update the spec first (before coding the change when possible), then resync
the plan and tasks. PRs reference their spec directory. A spec that no longer
describes the code is worse than no spec; delete or fix it.
