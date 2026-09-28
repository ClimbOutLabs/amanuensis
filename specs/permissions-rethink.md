# Permissions System Rethink (Sentinel) - Spec

**Status:** Draft for Sidd's review, Sep 28, 2026
**Problem:** The current approval system interrupts with unclear cards for routine actions. Normal users cannot tell what they are approving or why.

## Design principles

1. **Calibrate by consequence, not by action type.** Reading a file and deleting a database are not the same risk. The system should know the difference.
2. **Plain language, always.** No command strings, no technical identifiers. The user approves a consequence, not a command.
3. **One prompt per action for irreversible work.** Each Tier 3 approval gets its own card and its own decision. Batching trades carefulness for fewer clicks, which is the wrong tradeoff when the action cannot be undone.
4. **Default to trust for reversible work.** The agent is the user's assistant. Asking permission to do its job is broken.

## Three tiers

### Tier 1: Silent (no prompt)

Actions that are read-only or fully reversible within the workspace:

- Reading files
- Searching the web
- Running typecheck, lint, tests, builds
- Listing directories, checking git status
- Querying local databases (reads)

These never interrupt. They are the agent doing its job.

### Tier 2: Confirm in flow (inline, non-blocking)

Actions that change state but are reversible or low-stakes:

- Writing files in the workspace
- Running shell commands that don't delete data
- Installing dependencies
- Creating branches
- Updating configuration

The UI shows what is happening inline (a subtle indicator in the chat flow), with an option to undo or stop. No modal. No blocking. The user can intervene if they want, but they are not forced to.

### Tier 3: Hard stop (plain-language approval card)

Actions that are irreversible or leave the machine:

- Sending emails, messages, or posting publicly
- Deleting data
- Spending money or changing payment methods
- Sharing data with external services
- Running destructive commands

The approval card states in plain language:
- **What will happen** (one sentence, no jargon)
- **Why the agent wants to do it** (one sentence)
- **What cannot be undone** (if anything)
- **Approve / Deny** (two clear buttons, no ambiguity)

Example:
> **Send email to landlord**
> The agent wants to send your drafted reply about Thursday's viewing.
> This cannot be unsent after sending.
> [Send] [Don't send]

No command strings. No file paths. No "approve exec".

## Batching

Tier 3 approvals are always per action. No "approve all" for irreversible actions. Each one gets its own card and its own decision. Batching trades carefulness for fewer clicks, which is the wrong tradeoff when the action cannot be undone.

Tier 2 actions may be grouped in the audit stream but never require a batch decision.

## What changes in code

1. **Action classifier:** Every agent action gets tagged with its tier at the point of invocation. The classifier lives in one place, not scattered across call sites.
2. **Approval UI:** Replace the current card with the plain-language card above. No raw commands, no technical identifiers.
3. **Audit log:** Streams in the right rail as a live feed, alongside the agent's activity. Every Tier 2 and Tier 3 action appears with its plain-language description, timestamp, and the user's decision (approved, denied, or auto-handled). Visible but not interruptive.
4. **Tier 2 configuration:** Each Tier 2 action type has a per-user "always ask me" toggle. When enabled for a specific action type (e.g., file writes, shell commands), that action escalates to a Tier 3-style approval card. Default is off.

## What does NOT change

- The user can still deny anything.
- Tier 3 is still a hard block. The agent cannot proceed without approval.
- No silent irreversible actions, ever.

## Decisions

- **Toggle location:** Inline in the right rail feed, next to the action they control. Not in Settings.

## Deferred to v2

- **"Trust this task" option** that auto-approves Tier 3 for the current task only. Not building this until we see how the base three-tier system behaves in practice.
