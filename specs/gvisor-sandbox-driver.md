# gVisor Sandbox Isolation: Driver Spec

**Date:** 2026-09-28

## Problem

Aman runs model-generated code. That code is untrusted: it may attempt host escape, credential theft, or exfiltration. The existing Docker backend isolates with Linux namespaces, whose security boundary is the host kernel's full syscall surface. gVisor's runsc adds a userspace kernel (Sentry) that filters syscalls, so an escape must beat gVisor, not just namespaces.

## Goals

1. **Cheap:** zero idle footprint. No new always-on process.
2. **Fast:** cold start under 1 second.
3. **Local:** works wherever Docker works. No new network dependencies.
4. **Safe:** gVisor syscall filtering on top of existing Docker isolation. Network off. Read-only rootfs. Hard resource limits.

## Non-goals

- A new daemon, a new orchestrator, or a new API.
- Replacing the existing backend. The Docker driver stays the default.
- Per-run network egress (separate spec if ever needed).
- Warm container pooling.
- Windows/macOS parity.

## Design

`GVisorDriver` implements the existing `IsolationDriver` interface. It wraps `DockerDriver` (composition) and overrides one thing: the container runtime flag (`runtime: 'runsc'`). Readiness is inherited from `DockerDriver.ensureReady`; egress refusal lives in startup config validation. The mandatory resource flags below are set by `DockerDriver` and inherited unchanged.

```
docker create --runtime=runsc ... (all other flags unchanged)
```

Everything else is inherited unchanged from `DockerDriver`: code staging (`RunCodeService`), the cosign boot check, health probes, session resources, `runCodeProgramPath`, and `interpreterArgv`. The new surface beyond docker itself is the `ensureReady` runsc probe and the scratch quota supervisor. The supervisor is the wrapper-owned `diskLoop` (500ms poll); on quota breach it aborts via `controller.abort(DISK_REASON)` → `params.signal` → the driver kills the container per the interface contract. If the supervisor itself fails, the hard wall-clock timeout is the backstop.

### Driver selection

Config: `SANDBOX_ISOLATION_DRIVER`. Values: `docker` (default), `gvisor`. (`firecracker` is accepted by the config type but rejected as unimplemented.) Invalid values are rejected at config load (`parseIsolationDriver`). Driver instantiation is `getSharedRunCodeService` (`sessionResources.ts`, inline if/else on the parsed value); `firecracker` is rejected in `validateRunCodeStartupConfig` before instantiation, and the else-branch refuses to dispatch.

There is no cutover plan because there is no migration. The existing backend is untouched. Enabling gVisor is a config change; rolling back is the same config change in reverse.

### Fail-closed

This is the load-bearing requirement. The driver never silently falls back to `runc`. A silent fallback would delete the primary isolation guarantee with zero signal.

The readiness path (`ensureReady`, inherited from `DockerDriver`) must verify runsc before serving runs: a `runsc --version` probe confirms it is present and healthy, and the installed version is compared (exact match) against the pinned version recorded alongside the image manifest. If runsc is unavailable, unhealthy, or version-mismatched, the run is refused with a clear error naming runsc and how to install it. The error surfaces to the caller; it is never swallowed and never retried under a different runtime. A present-but-stale, CVE-vulnerable runsc does not pass.

(Implementation delta: the current tree's `ensureReady` runs a probe container with `--runtime runsc`; a missing runsc surfaces as generic `daemon_unavailable`, with no version pin and no runsc-naming error. The probe, the pin, and the clear error are required.)

### Resource limits

Mandatory Docker flags set on every run (inherited from `DockerDriver`). These are requirements, not tuning knobs.

- **CPU:** hard quota via `--cpus`. CPU shares alone are not a cap: shares only matter under contention, and a miner consumes all idle CPU. Untrusted code gets a hard quota.
- **Memory:** `--memory` cap with `--memory-swap` set equal to the cap (swap effectively disabled). A memory cap without a swap limit lets a run swap the host to death.
- **Scratch:** the per-run scratch dir is a host bind mount with a quota enforced by the `diskLoop` supervisor in `RunCodeService.runCode` (wrapper, 500ms poll) with kill against `diskMb` (the scratch+egress quota in MiB, set per run by the wrapper). On quota-kill or timeout the scratch dir is purged (without following run-planted symlinks) so the disk does not stay full. Instant allocation (`fallocate`) can outrun the poll: that residual race window is accepted risk, documented here. An unbounded scratch dir is a host DoS vector.
- **Processes:** `--pids-limit` set (fork-bomb protection).
- **Filesystem:** `--read-only` rootfs. Three bind mounts: the per-run staging directory at `/ingress:ro` (read-only; the code the run executes), the scratch dir at `/scratch:rw` (the run's working dir), and the egress dir at `/egress:rw` (where result files land; a fresh per-run directory, writable only by the run, harvested by copying files out — the harvest never follows symlinks: lstat/`O_NOFOLLOW`, only regular files are copied out). No other host paths are ever mounted.
- **/tmp:** `--tmpfs /tmp:rw,noexec,nosuid,size=64m`.
- **Core dumps:** `--ulimit core=0` (implementation delta; the current tree does not set it). A crashing run must not dump core to host disk.
- **Timeout:** the existing hard wall-clock timeout is unchanged (kill past deadline, no grace period games).

### Network and egress

No network, period. `GVisorDriver` pins `--network none` (hardcoded in `DockerDriver`, inherited). Egress is out of scope for this driver: startup config validation (`validateRunCodeStartupConfig`, global across drivers) refuses `SANDBOX_NETWORK_EGRESS=true` with a clear error; the setting is reserved for a future version and must be false in v1.

Per-run egress allowlists, tool-manifest egress grants, and any egress proxy are explicitly out of scope. If network access is ever needed, it gets its own spec and its own adversarial review. Designing a full egress proxy (enforcement point, DNS handling, manifest trust model, policy schema) inside an isolation-only change is over-engineering, and an allowlist enforced without DNS control is trivially bypassed anyway. This is isolation only.

Offline mode: the sandbox is fully offline-compatible. Network egress is controlled by `SANDBOX_NETWORK_EGRESS` (default false) plus `--network none` on every container; with egress off, the sandbox is unaffected by offline mode.

### Runtime environments

The driver runs the same language images as the existing `DockerDriver`: python, node, bash. No new images.

Version baselines (verify against the image manifest at implementation):
- **Python:** 3.12 slim, with pip present.
- **Node:** 22 slim, with npm present.
- **Bash:** slim base with coreutils, jq, and curl present.

Notes:
- pip/npm exist in the images but installs fail without network access. That is expected behavior, not a bug: no egress is granted.
- Image digests are pinned in the build-time image manifest. Images are pulled and created by digest reference (`image@sha256:<digest>`) so the daemon's content-hash verification is the verification; a digest mismatch is a refused run surfaced as an image error. Digest-reference construction and the `ensureReady` pin check live in `DockerDriver` and are inherited. The manifest handoff is operational: the release process stamps `SANDBOX_IMAGE=<tag>@sha256:<digest>` from the CI-rewritten tag in `sandboxImage.json` plus `crane digest` output → `SANDBOX_IMAGE` env → service configuration → `getSharedRunCodeService` → `DockerDriver` options. No `latest` tags anywhere.
- The runsc/gVisor version itself is pinned, not just the images. A stale runsc with known CVEs undermines the whole design. The update process: bump the pinned runsc version, re-run the acceptance suite, ship.
- Image contents per language are documented in the manifest (interpreter version, bundled tools). Aman writes code against a known environment, not an unknown one.
- Update story: images are rebuilt on CVEs, the digest manifest is updated, images are pulled at install/upgrade time.

### Setup

runsc is a host prerequisite, installed per the gVisor install docs for the host platform. After runsc is installed and the language images are pulled, no network is needed to stand up a sandbox.

If runsc is missing, the user gets a clear error at first run (fail-closed, above), not a hang and not a silent fallback.

### User-visible failure behavior

- runsc missing or unhealthy: clear first-run error naming runsc.
- Image pull failure: clear error naming the image.
- Run timeout: the existing `timed_out` result, so the agent can communicate failure in plain language.
- Queue full (if the driver implements a queue): backpressure with a clear "busy, try again" signal, never a silent drop.

### Security model

- Threat: arbitrary model-generated code (or pasted user code) attempting host escape, credential theft, or network exfiltration.
- Boundary 1: gVisor Sentry syscall filtering.
- Boundary 2: no network.
- Boundary 3: read-only rootfs, exactly three host bind mounts (`/ingress:ro`, `/scratch:rw`, `/egress:rw`), no secrets in the image.
- Boundary 4: hard resource limits and hard timeouts.
- Platform note: without `/dev/kvm`, runsc uses the ptrace platform, the weaker of gVisor's two platforms. Accepted risk, documented here. The backstop for a Sentry escape is the pinned, CVE-tracked runsc version; the non-Sentry boundaries (no network, read-only root, no secrets) limit what an escape can reach.
- runsc ignores Docker seccomp profiles; the syscall filtering boundary is Sentry, not a Docker seccomp profile.
- Secrets (API keys, tokens) never enter the sandbox. The driver passes only the curated env assembled by `RunCodeService` (PATH, LANG, HOME=/scratch, PIP_NO_INDEX=1, dead-end npm registry; `params.env` defaults to this set). `DockerDriver` turns `params.env` into `-e` flags and never forwards the host process env.
- Audit: the implementation logs every run with image, timeout, runtime (`runsc`), exit code, and duration. No code contents in the log by default (they may contain user data). (Implementation delta: the current tree has no per-run success logging, only warn/error.) Log destination and format are set at implementation.

## Performance targets

- **Cold start:** under 1 second from run request to code executing, measured on the user's hardware.
- **Warm start:** no target. No pooling.
- **Idle footprint:** zero. No daemon, no pooled containers.
- **Per-run overhead vs plain Docker:** acceptable up to 2x on syscall-heavy workloads. The sandbox runs snippets, not servers.

## Acceptance

Cold-start is measured on real hardware. The procedure:

1. For each language (python, node, bash): run a hello-world snippet through the real `runCode()` path with `SANDBOX_ISOLATION_DRIVER=gvisor`, timed with `time`.
2. Target: under 1 second per language on the user's hardware.
3. If the target is missed, this spec is revisited. It is not silently accepted.

Also required:
- Existing sandbox tests pass unchanged against the gVisor driver.
- Bash works end-to-end through the real `runCode()` path, including the staging seam (regression coverage: the filename the service stages must match the filename the driver executes).
- Security tests: an escape attempt is contained, an exfiltration attempt finds no network, a fork bomb is capped by the pids limit, a memory hog is killed at the cap.

## What this spec explicitly does NOT include

Stated plainly so nobody re-adds them:

- **No `sandboxd` daemon.** No daemon transport, no peer auth, no supervision, no input bounds, no concurrency design. There is no daemon.
- **No backend deletion, no flag-day migration.** The Docker driver remains the default. gVisor is opt-in via config.
- **No warm container pooling,** and no warm-start target.
- **No per-run network egress.** Network is off, full stop.

## Decided

- **Driver, not daemon:** `GVisorDriver` wraps `DockerDriver` in-process with `--runtime=runsc`.
- **Fail-closed on missing or unhealthy runsc.** Never fall back to runc silently.
- **Hard resource limits as Docker flags** (cpus quota, memory cap with swap disabled, scratch quota via du-poll, pids limit), mandatory.
- **Image digests pinned at build time; runsc version pinned too.**
- **Egress: none.** A future egress design gets its own spec.

## Success criteria

- `SANDBOX_ISOLATION_DRIVER=gvisor` runs python, node, and bash hello-world under runsc with cold start under 1s on the user's hardware.
- Missing runsc produces a clear error naming runsc at first run, not a silent fallback.
- Existing sandbox tests pass unchanged.
- No new always-on process. No network beyond the initial image pull (after runsc is installed).
