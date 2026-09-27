# Agent-session continuity architecture

Context compaction is host-owned. The compaction model fills the required `goal`, `done_so_far`, `in_flight_work`, `remaining_work`, `current_blocker`, and `bound_repository_state` sections. The host validates exactly one of each section, replaces repository identity from the resolved binding, and persists only the validated summary plus the continuation instruction.

Repository and checklist refreshes are request context, not conversation events. Before every model request, one processor removes legacy persisted host-context messages, loads the current durable checklist, and injects:

- the no-Sandbox binding with repository id, revision, workspace cwd, unavailable branch/HEAD, and the complete registered command list; or
- no repository message when Sandbox owns the binding instruction and refreshed branch/HEAD.

Before every Sandbox-backed model request, the host reads repository root, branch, and HEAD in one provider command under the workspace mutation lock. It verifies the root against the bound checkout and rebuilds the Sandbox instruction when branch or HEAD changes.

These messages are assembled only for the imminent `modelClient.create` call and are not retained in `AgentThread` snapshots or conversation history. The harness does not provide an exact production-request trace.

The task checklist is session-store state scoped by tenant and session. It contains at most 50 ordered `{ id, text, done }` items. Writes replace the full checklist with an expected revision; the host assigns the next revision and permits at most one retry in a stale replacement sequence.

Compaction capability state carries a maximum of 200 host-observed touched paths plus an overflow flag. Paths come from successful `tool.response.v2` results paired with the host-derived `implementation_plan_scope` on structured edits; model prose and patch text are never parsed as path evidence. Compaction preserves bounded model-authored completed-work notes and appends the host-owned ledger, explicitly marking truncated output.
