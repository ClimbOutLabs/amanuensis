# Permissions System Rethink (Sentinel) - Spec v2

**Status:** Draft for review, Sep 28, 2026 (revised to address the security review)
**Problem:** The current approval system interrupts with unclear cards for routine actions. Normal users cannot tell what they are approving or why.

## Design principles

1. **Calibrate by consequence, not by action type.** Reading a file and deleting a database are not the same risk. The system should know the difference.
2. **Plain language, always, with verifiable details.** The user approves a consequence, not a command. But verifiable destination details are always shown: who it goes to (email address, service name), where it goes (URL), and how much (amount). A card that hides the destination is a card the user cannot check. Exception: Tier 3 shell commands have no destination to verify, so the card shows the exact server-parsed command instead (see Tier 3).
3. **One prompt per action for irreversible work.** Each Tier 3 approval gets its own card and its own decision. Batching trades carefulness for fewer clicks, which is the wrong tradeoff when the action cannot be undone.
4. **Default to trust for reversible work.** The agent is the user's assistant. Asking permission to do its job is broken.
5. **Fail closed.** When the system cannot determine an action's risk, it treats the action as high risk, not low risk.

## Three tiers

### Tier 1: Silent (no prompt)

Actions that are read-only and side-effect-free:

- Reading files
- Searching the web
- Listing directories, checking git status
- Querying local databases (reads)

These never interrupt. They are the agent doing its job.

Reads of sensitive paths (SSH keys, credential files, .env) are logged in the audit feed even when they are Tier 1. They are not blocked; the agent needs to work. But a silent read of a private key leaves a trace.

### Tier 2: Confirm in flow (inline, non-blocking)

Actions that change state but are reversible or low-stakes:

- Writing files in the workspace
- Running typecheck, lint, tests, builds
- Creating branches
- Running shell commands on the server-side safe allowlist (see below)

The UI shows what is happening inline (a subtle indicator in the chat flow). What the user can do depends on the action: file writes and branch creation can be undone, and the indicator carries an undo control; running commands (tests, lint, builds, allowlist shell commands) can be stopped while in progress but not undone once finished, and the indicator carries a stop control. No modal. No blocking. The user can intervene if they want, but they are not forced to.

Workspace configuration files are file writes. User settings are never agent-writable and never appear as agent actions.

Note on tests and builds: test suites and build scripts execute code with the agent's full privileges, which may include code the agent itself just wrote. They are not read-only, so they are not Tier 1. They stay visible and non-blocking as Tier 2. They run through a dedicated runner tool (not generic exec). The runner accepts only a workflow identifier from a fixed enum (`test`, `lint`, `typecheck`, `build`) and no other parameters; the commands executed come from server-side configuration, never from a model-supplied string. Known residual risk, stated plainly: the named-workflow exemption is keyed on the workflow label, and the agent writes the workflow's inputs (package.json scripts, Makefile targets), so an agent can route arbitrary execution through a named workflow without triggering escalation. Compensator: when a named workflow executes files in the tracked executable set, the Tier 2 inline indicator names those files, so a watching user can intervene, regardless of which task wrote them. Mechanism: at runner invocation, the runner makes a best-effort resolution of the workflow's declared inputs by reading the live workflow files (package.json scripts including pre/post lifecycle hooks, Makefile targets, and similar) at invocation time, intersects the resolved file references with the tracked set, and names the matches in the indicator before execution. Inputs that cannot be resolved to files are still executed. During the run, the runner records each executable file it invokes (by file identity); tracked-set matches are flagged in the audit feed. Pre-execution naming lets the user intervene before the run; the runtime record is the after-the-fact audit. Known limitation: files loaded in-process (`require()`, `dlopen()`) by a named workflow are neither resolved pre-execution nor recorded at runtime.

**Shell command allowlist:** Shell commands are Tier 3 by default. Statically determining what a shell command does is undecidable, so no general rule is safe. The server parses the command with a shell-aware parser. The command must parse as a single simple command: no pipes, no redirects, no lists (`;`, `&&`, `||`, newlines), no command substitution (backticks and `$(...)`), no process substitution (`<(...)`), no other compound structure. The operative rule is structural, not the examples: anything that does not parse as a single simple command is Tier 3. The metacharacter check applies to the raw command string with quote-awareness, so a `;` inside a quoted argument is not misread. If the parse yields anything other than one simple command, the command is Tier 3. Matching then requires: exact match of argv[0] against the allowlist, resolved to an absolute path under a pinned PATH at parse time; and the remaining arguments matching that command's enumerated subcommand and flag list (an explicit list per command, covering all flag spellings and aliases, curated to exclude flag-smuggling such as git `--config`/`-c` overrides; for tools that accept unambiguous long-flag prefixes, no listed token may be a prefix of a dangerous flag; interpreters on the allowlist exclude code-string and module-preload flags (e.g. `-c`, `-e`, `--eval`, `--require`, `-r`, `-m`, `-M`, `--rcfile`)). Argument matching is exact-token; `--flag=value` and `--flag value` are distinct spellings and must be listed separately. Curation rules: the allowlist contains only commands with no network capability and no external effects; a network-capable command (e.g. `git ls-remote`) on the allowlist is a curation error, and such commands are Tier 2 (shown with their full argv) unless a Tier 3 rule applies. A wrapper prefix (`nice` only) is permitted in front of an allowlisted command only in the bare form: the wrapper token must be immediately followed by the allowlisted command's argv[0]. Any wrapper arguments (e.g. `nice -n 10`) fail closed to Tier 3. `timeout` is not a permitted wrapper (its mandatory duration argument cannot be expressed in the bare form); `env` is excluded because `VAR=val` assignments would inject agent-controlled environment (LD_PRELOAD, PYTHONPATH, and similar) into the allowlisted binary. The parsed argv is executed directly (exec-style); it is never re-serialized through a shell. The environment is sanitized: pinned PATH, a fixed working directory, no agent-influenced variables passed through, and `VAR=val` env-prefix assignments are rejected. The allowlist and the per-command argument lists are curated in server configuration and versioned with server releases; they are never derived from model output. Anything not on the allowlist is Tier 3.

**Write-then-execute escalation:** Writing executable content and then executing it escalates to Tier 3. "Executable content" means scripts, programs, and files a runner executes (test files, build scripts, package scripts, Makefile targets), regardless of the filesystem +x bit (`sh script.sh` needs no +x). "Executing" includes indirect execution through runners, interpreters, and task runners, not just direct shell invocation. The escalation is evaluated before allowlist matching: executing tracked content through an allowlisted interpreter still escalates to Tier 3. Exception: the named Tier 2 workflows (tests, lint, typecheck, builds) stay Tier 2 even when the agent authored the files involved, so the ordinary dev loop ("fix the failing test") does not produce a hard-stop card on every iteration. Escalation applies to arbitrary scripts and programs executed outside those named workflows. The classifier maintains a server-side tracked set of executable files by agent provenance across all creation paths: write-tool writes, files created or modified by the agent's shell commands (creating a hardlink with `ln` counts as file creation), and files materialized by agent-invoked tools (build outputs, sandbox results, and similar). Observation covers the workspace; files the agent writes outside the workspace are Tier 3 at write time by the path-scoped rule, and executing a file outside the workspace is Tier 3. File identity is the canonical absolute path with all symlinks resolved (realpath), normalized against the resolved working directory. The tracked set, the runner's runtime record, and the approved-hash store all key on file identity. Each entry is a file identity. Entries persist across conversations in server-side persistent storage keyed by (tenant_id, created_by, workspace) (not per-turn sandbox state, which is recreated each turn); an entry is removed via a delete-path hook when its file is deleted. Sandbox destruction orphans entries, which fail closed on lookup (no approved pairs for an orphaned identity, so execution escalates). The classifier extracts the executed file operand from the parsed argv: the first non-option argument after the interpreter, respecting `--` end-of-options (`sh script.sh` tracks `script.sh`; `sh -x script.sh` skips `-x`; `python -- script.sh` tracks `script.sh`; a `-c` operand is inline code, not a file), skipping wrapper prefixes and their arguments (`env` with `VAR=val` assignments and options ignored, `nice` with optional `-n`, `timeout` with its duration); unlisted wrappers are never allowlisted. The classifier resolves the operand's symlinks before the tracked-set lookup and before the workspace-membership test, so a symlink to a tracked file or to a path outside the workspace does not evade either check.

On execution of a tracked file, the classifier compares the file's current content hash and canonical argv hash against (content hash, argv hash) pairs the user has approved for that file identity. If no pair matches, the action escalates to Tier 3; the approval token binds both hashes, and approval records the pair as a payload-bearing grant record keyed by (conversation ID, file identity); records are purged when the conversation ends (the existing Set<string> grant keys cannot carry payloads; the implementation-plan-grant store shows the pattern). Byte-identical re-execution of the exact approved action does not re-escalate; the card states that the approval covers identical re-runs within the conversation. If the file's content or the arguments change, the next execution escalates again. Approval grants are conversation-scoped: the first execution of a tracked file in a new conversation re-escalates even if the file is unchanged.

### Tier 3: Hard stop (plain-language approval card)

Actions that are irreversible or leave the machine:

- Sending emails, messages, or posting publicly
- Deleting data
- Spending money or changing payment methods
- Sharing data with external services
- Installing dependencies (npm and pip run arbitrary install scripts; this is a supply-chain vector)
- Running shell commands not on the safe allowlist
- Writing files outside the workspace (e.g. `~/.ssh/authorized_keys`), regardless of content
- Executing files outside the workspace
- Any action the classifier cannot categorize

The approval card states in plain language:
- **What will happen** (one sentence, no jargon), including the verifiable destination: recipient address, destination service or URL, and amount where applicable
- **Why the agent wants to do it** (one sentence)
- **What cannot be undone** (if anything)
- **Why you are being asked again** (for re-escalation only): the card states the actual cause. If the file or its arguments changed: "script.sh changed since you approved it 10 min ago; any change, including by the agent, re-arms approval". If the approval was from an earlier conversation: "You approved this in an earlier conversation; approvals last only within one conversation."
- **Approve / Deny** (two clear buttons, no ambiguity)

Destination, amount, and service fields on the card are rendered server-side from the canonical action parameters through a server-side extractor registry keyed by (tool name, arguments). They are never taken from agent-supplied text. An extractor must cover every parameter capable of carrying a destination, recipient, or amount (e.g. `to` and also `cc`/`bcc`); if any such parameter is unextracted, the fallback triggers. Fallback: for external-service actions (sending email or messages, posting publicly, sharing data with external services, spending money) where the destination cannot be determined server-side, the action is auto-denied with reason "destination unverifiable" rather than carded. For other Tier 3 actions, the card states that the destination could not be determined and the action stays Tier 3.

Each approval is bound to the action it covers: the approval token references the action ID and a hash of the canonical parameters. For shell, the canonical parameters are the full server-parsed command structure: every simple command's argv with each argv[0] resolved to its absolute path at parse time, plus redirections (including heredoc bodies, not just targets), the working directory (symlinks resolved), and any environment overrides. The hash binds the sha256 content hash of executable-relevant file operands: the resolved argv[0] binary, the interpreter, the script or config operand (including package manifests and Dockerfiles), and any redirection source resolving to an existing file. Other argv tokens that resolve to files are bound by path only. Transitive runtime dependencies not named in argv (dynamically imported modules, sourced files) are a known limitation, disclosed like the require()/dlopen() limitation above. Tokens are single-use. All path resolution, content hashing at mint, and pre-invocation re-verification execute inside the execution sandbox via the provider (against the sandbox's pinned PATH), not host-side; if no sandbox exists at mint time, the server ensures one before capturing. The server normalizes cwd and env identically at token mint and at re-validation: symlinks resolved, empty or unset cwd falls back to the workspace root. A normalization mismatch fails closed. Immediately before invocation, the server re-verifies the content hashes byte-for-byte against the exact parameters about to be executed; if anything covered by the hash changed after approval, the approval is invalid and the agent must request approval again. If offline mode was enabled after the approval was granted, external-service actions are auto-denied per the offline rule (no card); non-external approvals remain valid. The executor invokes the validated canonical paths via an argv-bearing provider extension (not the string-command provider.exec), never re-resolved strings. This minimizes the approval-to-invocation window to the classifier/executor boundary: substituted parameters cannot execute without a fresh approval.

Example:
> **Send email to landlord (landlord@example.com)**
> The agent wants to send your drafted reply about Thursday's viewing.
> This cannot be unsent after sending.
> [Send] [Don't send]

No raw command strings, with one exception: Tier 3 shell cards show the exact server-parsed command in a code block alongside the plain-language explanation. For a simple command this is the parsed argv with argv[0] resolved to its absolute path at parse time; for a compound command (pipes, chaining, redirects) the card shows the full parsed command structure, since there is no single argv. The card also shows the working directory and any non-default environment overrides. For a shell command there is no destination to verify, so the command itself, in its execution context, is the verifiable detail.

While a Tier 3 card is pending, the agent may continue independent work that does not depend on the decision. It never proceeds with the gated action.

## Classification

**Single authoritative classifier, server-side.** Classification is computed once, server-side, at action invocation. The tier is propagated with the action to the UI on a required server-owned `tier` field on InternalToolCallInfo, flowing through the existing `tool.approval_required` / `user.tool_approval` event pair. The UI renders the propagated tier as a code invariant; it never re-derives it. This closes the known server/UI tier disagreement: there is one classification, made in one place, and the UI displays what the server decided.

**Classifier inputs only.** The classifier uses server-known action types and canonical parameters. It ignores tool-supplied metadata and model output, except the declared MCP `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations, which are advisory inputs only: they may escalate a tier, never lower one, and they never bypass the classifier. Server-unknown tools default to Tier 3 regardless of hints.

**Dispatch order.** The classifier runs at action dispatch, before the existing approval check. It sets `is_approval_required` from the tier: Tier 3 requires approval; Tier 1 and Tier 2 do not (Tier 2 shows the inline indicator instead). The classifier's tier decision supersedes `HostToolCallPolicy.requiresApproval` for tiered actions.

**Fail-closed default.** Actions the classifier cannot categorize default to Tier 3. Unknown or ambiguous actions are never silent.

## Offline mode

A global user toggle (Settings; user-only, the agent cannot change it). When on:

- The backend filters the tool list: any tool with `requires_network: true` is not offered to the model. It is not invoked. If a call is attempted anyway (stale context), it fails fast with an `offline_mode` error.
- `requires_network` is a new server-side annotation on the tool definition, populated from a hand-curated per-tool registry, not from tool self-declaration. It is consulted both when filtering the model-visible tool list and at call time for the stale-context guard. The declaration is trusted only for first-party/server-authored tools; third-party and MCP tools default to `requires_network: true` unless individually reviewed.
- Tier 3 actions involving external services (sending email or messages, posting publicly, sharing data with external services, spending money) are auto-denied with reason "offline mode". No card is shown; the agent receives an `offline_mode` error for the denied call and the denial is recorded in the audit log. The offline deny is evaluated first, before chat grants, plan grants, and stored user decisions: a pre-existing grant never bypasses offline mode.
- The exec tool declares `requires_network: false`; its offline restriction is enforced by the call-time rule below, not by list filtering. In offline mode the exec tool is restricted to an explicit no-network subset of the allowlist (enumerated commands with no network capability, curated separately; "read-only" does not imply "no network", e.g. `git ls-remote` is read-only and phones home). Any other shell command is auto-denied. In offline mode exec additionally runs with network access revoked at the process layer, so the no-network guarantee is enforced by mechanism, not curation alone.
- The UI shows a persistent offline indicator while the mode is on. When offline mode is toggled on, the server revokes network access at the process layer for already-running agent-spawned processes (all processes spawned by the agent's tools, including their children), blocks new networked tool calls, and auto-denies Tier 3 external actions from that point forward.

Local tools keep working: file reads and writes, the offline no-network shell subset, the STT sidecar, and the sandbox all run without network access. Tests, lint, typecheck, and builds run through the dedicated runner tool annotated `requires_network: false`. In offline mode the runner executes with network access revoked at the process layer, so a network-dependent build fails with an error naming offline mode. The sandbox declares `requires_network: false` and is fully offline-compatible.

## Batching

Tier 3 approvals are always per action (design principle 3). Tier 2 actions may be grouped in the audit stream but never require a batch decision.

## What changes in code

1. **Action classifier:** Every agent action gets tagged with its tier at the point of invocation, server-side. The classifier lives in one place, not scattered across call sites. It computes the tier once; the tier travels with the action.
2. **Approval UI:** Replace the current card with the plain-language card above, including verifiable destination details. No raw commands, except the Tier 3 shell exception above.
3. **Audit log:** Streams in the right rail as a live feed, alongside the agent's activity. Every Tier 1 read of a sensitive path and every Tier 2 and Tier 3 action appears with its plain-language description and timestamp. The recorded outcome is per tier: Tier 1 reads show "logged"; Tier 2 shows "ran", "stopped by user", or "undone"; Tier 3 shows approved, denied, or auto-denied (including "offline mode"). Visible but not interruptive. The audit log lives in a dedicated append-only store: not in workspace files and not in the user settings store. The agent has no tool surface that can modify it. Entries are written before the action executes. Retention is bounded (default 90 days).
4. **Tier 2 configuration:** Each Tier 2 action type has a per-user "always ask me" toggle, pinned to exactly the Tier 2 member list (no new taxonomy). When enabled for a specific action type (e.g., file writes, shell commands), that action escalates to a Tier 3-style approval card. Default is off. Toggles live in a user settings store partitioned from the agent-writable profile; the server rejects writes that do not come from a UI session, so agent actions can never change them. The offline-mode toggle lives in Settings, not in the right-rail feed.

## What does NOT change

- The user can still deny anything.
- Tier 3 is still a hard block. The agent cannot proceed without approval.
- Nothing de-escalates a Tier 3 action outside a fresh approval card. The Tier 2 "always ask me" toggles only escalate; they never de-escalate. The sole exception is the approved-hash record for tracked files, which suppresses re-escalation only for byte-identical re-execution of the exact approved action (same file content and same canonical argv); any other action, including the same file with different arguments, requires a fresh card.
- No silent irreversible actions, ever.

## Decisions

- **Toggle location (Tier 2 per-action toggles):** Inline in the right rail feed, next to the action they control. Not in Settings. (The offline-mode toggle lives in Settings.)

## Deferred beyond v2

- **"Trust this task" option** that auto-approves Tier 3 for the current task only. Not building this until we see how the base three-tier system behaves in practice.

---

## Implementation Status (Sep 30, 2026)

### Classifier Hardening (Complete)

The tier classifier (`packages/trueforge-core/src/core/permissions/classifier.ts`) has been hardened against bypasses found in adversarial review:

**SECURITY fixes:**
1. **Environment variable escalation:** `exec` with non-empty `env` now classifies as Tier 3 (was Tier 2). The executor honors `env`, so `LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV` and similar could be abused for code injection.
2. **Runner workflows to Tier 3:** `run_workflow` (test, lint, typecheck, build) now classifies as Tier 3 (was Tier 2). The agent controls workflow inputs (`package.json` scripts, Makefile targets) and can route arbitrary execution through a named workflow.
3. **MCP exec spoofing removed:** Shell `exec` classification now requires `tool_type: 'truefoundry-system'`. Any MCP tool named `exec` falls through to fail-closed Tier 3.

**Workspace boundary fixes:**
- **A2 (cwd validation):** Allowlisted command `cwd` is validated against the workspace. `exec({command: "cat passwd", cwd: "/etc"})` no longer reads outside the workspace at Tier 2.
- **A3 (symlink escape):** File operands are resolved and symlink escapes outside the workspace are rejected.
- **A4 (new-file cards):** New write targets use canonical path resolution so in-workspace new files are no longer mislabeled "outside the workspace."

**Dead code removed:** `runner.ts` stripped to only `isRunnerWorkflow` (the only function actually used). Removed `defaultRunnerServerConfig`, `resolveWorkflowInputs`, `buildRunnerRuntimeRecord` and their types.

### Host Wiring Design (APPROVED)

**Status:** INTEGRATION reviewer APPROVED v3 on Sep 30, 2026.

**Problem:** Three backend sites accept an optional `SentinelHostContext` but none construct or pass it. Without wiring, classification and dispatch verification are inert.

**Design (summary):**
1. **Creation point:** Per session, at the `SessionHandle` layer (has `this.session` with `tenant_id`, `session_id`, `created_by`).
2. **Threading:**
   - `TurnResourceResolver.resolveAgentDefinition`: Add `tenant_id`/`created_by`/`session_id` as per-method params (matches existing `resolveSandbox` pattern in the same class). Applies to both main thread and sub-agent thread (`makeCreateDynamicSubAgentThread`) call sites.
   - `AgentThread`: Add `sentinel?: SentinelHostContext` to `AgentThreadConstructorInput`, store as field, pass to `executeToolCalls`. Applies to both `buildThread` and `makeCreateDynamicSubAgentThread`.
   - `Sandbox`: Add to `buildTurnSandbox` input.
   - Update `ITurnResourceResolver` interface to match.
3. **Services:**
   - Approval tokens: in-memory with TTL (single-use, short-lived)
   - Tracked executables: in-memory, session-scoped, purged on teardown (per interface docs)
   - Audit: append-only log via existing `audit.ts`
   - Offline-state: use existing connectivity check
   - Always-ask settings: via Sentinel settings API (routes to be implemented)
4. **Lifecycle:** Session-scoped. Create on session start (or lazily on first tool call). Tracked grants purged on teardown. Approval tokens expire via TTL.

**Security note:** The sub-agent paths (`makeCreateDynamicSubAgentThread`) must be wired. Without them, Tier 3 operations could execute via delegated sub-agents with no approval gate.

### Hard Rules

- **No spaghetti code** (Sep 30, 2026): Quick hacks, hardcoded defaults, duplicated logic, and context threaded through layers it doesn't belong in are all spaghetti. The EFFICIENCY/CODE QUALITY reviewer explicitly checks for this. If a fix needs architectural design, stop and design; do not patch around it.
