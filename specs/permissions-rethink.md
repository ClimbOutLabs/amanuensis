# Spec: Permissions System with Tiered Approvals

**Status:** implemented

## Problem

The agent takes actions on the user's behalf, from reading files to sending emails. Some actions are safe and routine; others are irreversible or leave the machine. Without clear tiers, the user either gets interrupted for everything or approves things they should have examined closely.

## Solution

A three-tier permission system. Tier 1 runs silently. Tier 2 asks by default but the user can relax specific action types. Tier 3 always asks, one call at a time. Approval cards use plain language with verifiable details: who it goes to, where it goes, how much.

## The Three Tiers

### Tier 1: Silent

Runs without asking:

- Read-only allowlisted shell commands inside the workspace. The server parses the command: it must be a single simple command (no pipes, redirects, or chaining), argv[0] must match the allowlist exactly, flags must be on the command's enumerated flag list, and positional operands are allowed only where the command's own policy permits them (workspace-relative paths).
- Local read-only system tools (first-party tools that only read, never write or reach outside the machine).

These are the agent doing its job. Reads of sensitive paths (SSH keys, credential files, .env) are logged in the audit feed even when silent.

### Tier 2: Asks by default

Actions that change state but are reversible or low-stakes. Today this covers only file writes:

- Writing files in the workspace

The user sees an approval card and can approve or deny. There is one per-user relaxation toggle in the right rail, for file writes. When enabled, file writes run without asking.

Scheduled runs never use relaxed permissions. A scheduled task always asks, even if the user relaxed file writes for interactive use.

### Tier 3: Always asks

Actions that are irreversible or leave the machine:

- Sending emails, messages, or posting publicly
- Deleting data
- Spending money or changing payment methods
- Sharing data with external services
- Installing dependencies
- Running shell commands not on the allowlist
- Writing files outside the workspace
- Executing files outside the workspace
- Any action the classifier cannot categorize

Each approval covers one call. There is no batch approval for Tier 3. The card states what will happen (one sentence), why the agent wants to do it, what cannot be undone, and the verifiable destination: recipient address, destination service or URL, and amount where applicable. Tier 3 shell cards show the exact server-parsed command.

## Connector Tools

Web search and other connector tools always ask. They are never Tier 1, even for read-only operations. The user sees what the agent wants to look up before it runs.

## Durable Approvals

Approvals survive restarts. When the user approves a Tier 2 or Tier 3 action, the approval is recorded in persistent storage keyed by the action's parameters. If the server restarts, the approval still stands for the action it covered. A changed action (different parameters) requires a fresh approval. Approvals are single-use: each approval covers one call and cannot be replayed for a later action.

## Classification

Classification is computed once, server-side, at action invocation. The tier travels with the action to the UI on a server-owned field. The UI renders the propagated tier; it never re-derives it. Actions the classifier cannot categorize default to Tier 3. The classifier ignores tool-supplied metadata except the MCP read-only and destructive hints, which can only escalate, never lower a tier.

## Privacy

- Approval history and the audit log are stored in the server's database
- Every Tier 2 and Tier 3 action that is decided or runs appears in the audit feed with its outcome
- Tier 1 reads of sensitive paths are logged

## Testing

- Tier 1 actions run without prompting
- Tier 2 asks by default and respects the per-user relaxation toggle
- Scheduled runs always ask even when the action type is relaxed
- Tier 3 always asks, one call at a time, with no batch approval
- Web search asks before running
- Approvals survive a server restart
- Unclassifiable actions default to Tier 3

## Out of Scope

- Per-task auto-approval for Tier 3
- Granular per-command allowlist editing in the UI
- Offline mode: a separate switch in Sentinel settings, not part of the tier system
