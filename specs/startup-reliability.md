# Startup Reliability Spec

**Status:** Draft spec for review.
**Motivation:** Aman should come up cleanly on every machine. Right now, users discover missing dependencies, bad config, and unhealthy services at runtime through cryptic errors instead of at startup through clear ones. This spec adds the observability that makes "it doesn't start" a five-minute fix instead of a support thread.

## Overview

Five small, independent improvements to Aman's startup path:

1. **`doctor` command**: a preflight check the user runs before starting, or when something is broken.
2. **Deep readiness probe**: `/readyz` that actually verifies dependencies, used by Compose healthchecks.
3. **Startup dependency summary**: one log block at boot showing what's up and what's not.
4. **Zero-models warning**: loud warning when no model provider is configured.
5. **Sandbox status in UI**: the capabilities API reports sandbox availability so the UI can say "code execution unavailable" instead of failing silently.

Each can ship independently. None change runtime behavior; they only add visibility.

## 1. Doctor Command

**Command:** `npx @truefoundry/trueforge doctor`

**CLI integration:** There is no `aman` binary. The package is `@truefoundry/trueforge` with `bin: ./dist/cli.js`, so the real invocation is `npx @truefoundry/trueforge doctor`. The current `packages/trueforge/src/cli.ts` is a single file (not a directory) using `parseArgs` with `allowPositionals: false` and `strict: true`, so a bare `doctor` positional currently errors. Adding the subcommand requires a small dispatch change: check `process.argv[2] === 'doctor'` before `parseArgs` and branch to the doctor implementation instead of the server boot path. This keeps the existing flag behavior untouched while adding the subcommand.

**What it does:** Runs a series of checks against the current machine and config, prints PASS/FAIL for each with a concrete fix suggestion on failure. Exit code 0 if all pass, 1 if any fail.

**Checks:**

| Check | How | On failure, suggest |
|---|---|---|
| Node version | `process.version` vs minimum in `package.json` engines | "Install Node >= X (nvm install X)" |
| Database reachable | Connect with configured DATABASE_URL (or check SQLite path writable) | "Is Postgres running? Try: docker compose up -d postgres" |
| Redis reachable | `redis-cli ping` or node-redis connect with REDIS_URL | "Is Redis running? Try: docker compose up -d redis" |
| Docker available | `docker info` succeeds | "Install Docker Desktop: https://www.docker.com/products/docker-desktop" |
| Ports free | Attempt to bind PORT and any configured service ports | "Port 3000 is in use by PID 1234. Kill it or set PORT=3001" |
| Disk space | `df` on data directory, warn under 1GB free | "Free up disk space; Aman needs at least 1GB for SQLite/WAL and sandbox images" |
| Model provider reachability | For each configured provider, TCP connect to the endpoint host:port (no auth, just reachability) | "Cannot reach Ollama at localhost:11434. Is it running?" |

**Output format:**

```
$ npx @truefoundry/trueforge doctor

  Node version ............ PASS (v22.14.0)
  Database ................ PASS (postgres://[redacted]@localhost:5432/aman)
  Redis ................... PASS (redis://localhost:6379)
  Docker .................. PASS (v27.3.1)
  Ports ................... PASS (3000, 3001 free)
  Disk space .............. PASS (42GB free)
  Model providers ......... FAIL (cannot reach http://localhost:11434)

  1 check failed. Fix the above and re-run.
```

**Credential redaction (required):** Connection URLs and secrets are redacted in all `doctor` output, both human-readable and `--json`. A real `DATABASE_URL` looks like `postgres://user:password@host:5432/aman`; the display must show `postgres://[redacted]@host:5432/aman`. The `detail` field of each check result must never contain credential material (no passwords, tokens, or API keys). Redis URLs, model provider endpoints, and any other secret-bearing strings get the same treatment. Redaction happens at the point of display, not in the config itself, so checks still connect with the real values.

**Details:**

- Each check has a 5-second timeout. A timeout counts as FAIL with "timed out after 5s" in the message.
- Checks run sequentially (not parallel) so output is deterministic and easy to read.
- The model provider check does not send credentials or make API calls. A TCP connect is enough to distinguish "server down" from "wrong API key" (the latter is a runtime concern, not a startup one).
- `doctor` reads the same config loading path as the server (`config.ts`), so it validates env vars the same way. Invalid config fails fast with the existing specific error messages.
- In CI or scripts, `--json` flag outputs machine-readable JSON: `{"checks": [{"name": "docker", "pass": true, ...}], "pass": false}`.

**Files:**

- New: `packages/trueforge/src/doctor.ts` (command implementation; sits next to `cli.ts` since `src/cli/` does not exist)
- New: `packages/trueforge/src/doctor/checks.ts` (individual check functions, each returning `{name, pass, detail, fix}`; note `src/doctor/` is a new directory, not `src/cli/doctor/`)
- Edit: `packages/trueforge/src/cli.ts` (add subcommand dispatch: if `process.argv[2] === 'doctor'`, run the doctor command and exit instead of parsing server flags; update `printUsage()` to document the subcommand)

The subcommand dispatch is a deliberate, if small, structural change: today `cli.ts` has no subcommands (`allowPositionals: false`, only `--port`/`--help` flags). The dispatch keeps the server boot path byte-identical and adds one branch for `doctor`. No existing flags or behavior change.

## 2. Deep Readiness Probe

**Problem:** `/healthz` returns `{status: 'ok'}` without checking anything. Compose marks the server healthy even if its database connection broke after startup. A container can be "healthy" and completely non-functional.

**Solution:** Add `/readyz` as a separate endpoint.

- `/healthz` stays as the **liveness** probe: "is the process alive?" Returns 200 if the event loop is running. Cheap, no I/O.
- `/readyz` is the **readiness** probe: "can this instance serve traffic?" Checks:
  1. Database: run `SELECT 1` (or equivalent). Must succeed within 3 seconds.
  2. Redis: `PING`. Must succeed within 3 seconds. (Skip if Redis is not configured, e.g. SQLite standalone mode.)

- `/readyz` returns 200 with `{"status": "ready", "checks": {"db": "ok", "redis": "ok"}}` when all pass.
- Returns 503 with `{"status": "not_ready", "checks": {"db": "ok", "redis": "fail: connection refused"}}` when any fail. The per-check detail helps operators without exposing internals (no stack traces, no connection strings).

**Compose changes:**

```yaml
server:
  healthcheck:
    test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/readyz"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 60s
```

`depends_on` entries that gate on the server should use `service_healthy` against the new check. The `start_period` gives migrations and initial connects time to settle before the first check counts.

**Details:**

- The readiness checks reuse the server's existing DB and Redis clients. No new connections per probe.
- Results are not cached. Each `/readyz` hit runs the checks live. At a 30s interval this is negligible load.
- If the database is SQLite (standalone mode), the check is a trivial query against the open handle. Redis is skipped entirely when not configured.
- `/readyz` follows the same auth rules as `/healthz` (whatever those are for the deployment). It does not bypass auth; the per-check detail stays minimal ("connection refused") so a 503 body reveals nothing sensitive.

## 3. Startup Dependency Summary

**Problem:** When Aman boots, the operator gets a wall of logs. Whether the sandbox, models, and external services are working is buried or absent. The first sign of a problem is a user-facing failure minutes later.

**Solution:** Print one summary block at boot, after config load and before listening:

```
  Aman starting...
  ─────────────────────────────
  Database ............ ✓ postgres (localhost:5432/aman)
  Redis ............... ✓ connected
  Sandbox ............. ✗ unavailable (code execution disabled)
  Models .............. 2 configured (nemotron-3-5-lightning, deepseek-local)
  Auth ................ ✓ OIDC enabled
  ─────────────────────────────
  Listening on :3000
```

**Details:**

- Each line is one dependency. Status is `✓` or `✗`, never a third state. "Degraded but working" is `✓` with a parenthetical note.
- The sandbox line reports the configured driver and its probe result: `✓ docker (runsc available)` or `✗ unavailable (code execution disabled)`. This surfaces gap #5 from the audit at the earliest possible moment.
- The models line counts configured providers and names them. Zero models is still `✓` here (the count is informative); the loud warning is a separate item (section 4).
- This block goes to stdout (not just the log file) so `docker compose up` shows it inline.
- Keep it to six lines max. If a new dependency is added later, it gets a line; if the block grows past eight lines, revisit.

## 4. Zero-Models Warning

**Problem:** The server boots happily with zero model providers configured. The user only discovers this when they send their first chat message and it fails. By then they have lost trust in the install.

**Solution:** If no model providers are configured at startup, print a prominent warning that cannot be missed:

```
  ┌─────────────────────────────────────────────────┐
  │  WARNING: No model providers configured.        │
  │  Chat will not work until you add one.          │
  │  Go to Settings → Models, or set MODEL_ env vars. │
  └─────────────────────────────────────────────────┘
```

**Details:**

- The box uses plain ASCII so it renders correctly in every terminal and log viewer.
- It prints after the dependency summary (section 3), so the models line reads `Models .............. 0 configured` followed immediately by the warning box. The two reinforce each other.
- This is a warning, not a fatal error. There are legitimate reasons to boot without models (migrations, config inspection, the `doctor` command itself). Blocking boot would break those flows.
- The message names the two ways to fix it (UI path and env var path) because the person reading the log might be an operator, not the end user.

## 5. Sandbox Status in UI

**Problem:** When the sandbox is unavailable, the server logs a warning and continues. The UI has no idea. The user tries to run code, and it fails at runtime with an error that does not explain the actual cause ("execution failed" instead of "sandbox not available").

**Solution:** Surface sandbox availability through the existing capabilities API.

**API change:**

`GET /api/v1/capabilities` gains:

```json
{
  "sandbox": {
    "available": false,
    "driver": "docker",
    "reason": "docker daemon not reachable"
  }
}
```

When available:

```json
{
  "sandbox": {
    "available": true,
    "driver": "docker",
    "reason": null
  }
}
```

**UI change:**

- Wherever the UI offers code execution (chat composer attachments, run buttons, tool result panels), check `capabilities.sandbox.available`.
- When false, show a non-blocking notice: "Code execution unavailable (sandbox not reachable)." Do not hide the UI entirely; the user may be reading a document that does not need execution, and the sandbox may come back.
- The notice links to a help popover explaining what the sandbox is and how to fix it ("Start Docker Desktop" / "Check Settings → Sandbox").

**Details:**

- `reason` is a short human-readable string, not a stack trace. Examples: `"docker daemon not reachable"`, `"runsc not installed"`, `"driver not configured"`.
- The capabilities endpoint is already polled/cached by the UI; no new polling infrastructure needed.
- This does not change the Sentinel permission flow. A Tier 3 action still shows an approval card when the sandbox is available. When the sandbox is unavailable, the action fails fast with the clear reason instead of reaching the sandbox driver and producing a confusing error.

## Out of Scope

- **Automatic Docker installation.** The `doctor` command tells the user how to install Docker; it does not install it. (Installer project is parked separately.)
- **Retry/backoff for Redis at boot.** Compose `depends_on` handles ordering in the containerized path. Worth revisiting if standalone-mode Redis failures become a real support burden.
- **Migration rollback tooling.** Migration failures are rare and the current behavior (crash with the migration name in the log) is acceptable for now.
- **Model API key validation at startup.** `doctor` checks reachability, not credentials. Validating keys would require making authenticated calls at boot, which leaks key material into logs on failure and slows startup.

## Acceptance Criteria

1. `npx @truefoundry/trueforge doctor` runs all seven checks, prints PASS/FAIL with fix suggestions, exits 0/1 correctly, and supports `--json`. No credentials appear in human or `--json` output (connection URLs show `[redacted]` for the userinfo part).
2. `/readyz` returns 200 when DB and Redis are healthy, 503 with per-check detail when either is down. `/healthz` is unchanged.
3. Compose healthcheck points at `/readyz`. A server with a killed database connection is marked unhealthy within 60 seconds.
4. Boot prints the six-line dependency summary to stdout. Sandbox and model counts are accurate.
5. Booting with zero models prints the warning box. Booting with models does not.
6. `GET /api/v1/capabilities` includes the `sandbox` object. UI shows "Code execution unavailable" when `available` is false.
7. All existing startup tests still pass. New tests cover: doctor checks (mocked), `/readyz` healthy/unhealthy, summary rendering, zero-models warning trigger, capabilities sandbox field.
