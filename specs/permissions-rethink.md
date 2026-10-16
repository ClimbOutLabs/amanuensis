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
- Connector calls admitted by a standing trust (see Connector Tools).

These are the agent doing its job. Reads of sensitive paths (SSH keys, credential files, .env) are logged in the audit feed even when silent.

### Tier 2: Asks by default

Actions that change state but are reversible or low-stakes. Today this covers only file writes:

- Writing files in the workspace

The user sees an approval card and can approve or deny. There is one per-user relaxation toggle in the right rail, for file writes. When enabled, file writes run without asking.

Scheduled runs never use relaxed permissions: in an unattended run the relaxation set is empty, so a file write that would run silently for an interactive user parks for approval instead of running while nobody watches.

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

Three cases never reach a card and are denied outright, with the denial recorded in the audit feed: the destination cannot be verified from the call's parameters; offline mode is on and the action needs the network; or the outbound secret guard trips over text the call would send off the machine. Shell commands have their own offline rule: while offline, only the offline subset of the allowlist may run.

## Connector Tools

Connector tools ask by default. A connector call the classifier recognises gets a Tier 3 card showing the exact arguments it would send; an unrecognised one fails closed the same way. The user sees what the agent wants to look up before it runs.

Three standing trusts run a connector call without a card instead. Each runs as Tier 1, each is recorded in the audit feed, and none applies to a call that reads a sensitive path:

- First-party connector tools that declare themselves read-only and closed-world. A third-party tool's own hints never lower its tier; the hints admit a tool only under this host trust or the next one.
- A tool the user has given a standing Always allow grant (see Durable Approvals).
- Web search through the user's designated search provider, while the search switch in Sentinel settings is on (it is on by default). Silent search is bounded: the outbound secret guard must pass over the text the search would send, at most 20 silent searches run per turn, and a silent fetch may only name URLs the provider's own results returned. When any bound fails, the search asks instead, or is denied outright in an unattended run.

## Durable Approvals

An approval is given at one of three scopes, chosen on the card:

- **Once.** The approval is a single-use token recorded in the server's database, bound to a hash of the action's exact parameters. It survives restarts, so an approval given before a restart still stands for the action it covered. Immediately before the call runs, the server re-verifies the parameters byte-for-byte; anything the hash covers that changed after approval invalidates the token and the agent must ask again. A changed action (different parameters) always requires a fresh approval, and a once approval cannot be replayed for a later action.
- **Approve for this chat.** The exact tool is granted for the rest of the session: later calls to it in the same chat are admitted without a card. The grant applies only where the tool allows chat scope, and it ends with the session.
- **Always allow.** A standing per-user grant for one read-only connector tool on one connector, recorded in the server's database and applied until the user revokes it. Calls it admits run as Tier 1 and are recorded in the audit feed. It never crosses to another user, connector, or tool.

Approving an implementation plan is a separate path: it admits the calls the plan covers, under the plan's own binding, rather than any of the three scopes above.

## Classification

Classification is computed once, server-side, at action invocation. The tier travels with the action to the UI on a server-owned field. The UI renders the propagated tier; it never re-derives it. Actions the classifier cannot categorize default to Tier 3. Tool-supplied metadata is otherwise ignored, with one bounded exception: the MCP read-only and destructive hints. The hints can always escalate. They lower a connector call to Tier 1 only under host trust (a first-party connector, or the user's standing grant), only while the tool still declares itself read-only and closed-world, and never for a sensitive read.

## Privacy

- Approval history and the audit log are stored in the server's database
- Every Tier 2 and Tier 3 action that is decided or runs appears in the audit feed with its outcome
- Tier 1 reads of sensitive paths are logged

## Testing

- Tier 1 actions run without prompting
- Tier 2 asks by default and respects the per-user relaxation toggle
- Scheduled runs never apply relaxations: an action that would ask parks for approval, and a held search is denied
- Tier 3 always asks, one call at a time, with no batch approval
- A Tier 3 action with an unverifiable destination, a network need while offline, or a payload the outbound secret guard trips on is denied without a card
- Web search through the designated provider runs silently within its bounds (guard pass, turn cap, returned URLs only) and asks when the switch is off or a bound fails
- First-party read-only closed-world connector tools, and tools holding an Always allow grant, run without a card and are audited
- Chat-scope and Always allow approvals admit later calls at their scope; a once approval cannot be replayed
- Approvals survive a server restart
- Unclassifiable actions default to Tier 3

## Out of Scope

- Per-task auto-approval for Tier 3
- Granular per-command allowlist editing in the UI
- Offline mode: a separate switch in Sentinel settings, specified elsewhere; inside the tier system it only auto-denies actions that need the network and narrows the shell allowlist to its offline subset
