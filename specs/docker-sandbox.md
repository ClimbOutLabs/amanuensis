# Docker for Aman Sandbox: Spec

**Date:** 2026-10-08

## User Journeys

### Journey 1: User asks Aman to run code

The user says: "Write a Python script to analyze this CSV and show me the summary." Aman writes the script, then needs to run it. The script executes in an isolated container — it can read the CSV, compute the summary, and return results. The user's host machine is untouched. If the script has a bug or tries something malicious, the container contains it.

**Without Docker:** Aman can write the script but can't run it. The user has to copy-paste into their own terminal, defeating the purpose of an assistant.

### Journey 2: User asks Aman to try something untrusted

The user says: "I downloaded this script from the internet, can you check if it's safe and run it?" Aman examines the script, then runs it in the sandbox. The sandbox has no network access, a read-only filesystem except for a scratch area, and strict resource limits. If the script tries to exfiltrate data or consume all memory, the sandbox stops it.

**Without Docker:** Aman has to refuse, or the user has to take the risk themselves. The safety guarantee is gone.

### Journey 3: User asks Aman to install and test a tool

The user says: "Set up a quick web scraper for this site and show me what it finds." Aman creates an isolated environment, installs the needed packages, runs the scraper, and returns the results. The user's main Python environment isn't polluted with one-off dependencies.

**Without Docker:** Dependency conflicts, polluted environments, or Aman can't do it at all.

### Journey 4: User connects an MCP server or skill

The user says: "Connect my Gmail via MCP." Aman starts the Gmail MCP server. The server runs in an isolated container — it has its own dependencies, can't interfere with Aman's main process, and if it crashes, it doesn't take Aman down. Same for user-defined skills that need to execute code: each runs isolated.

**Without Docker:** MCP servers run as raw host processes. A buggy or malicious MCP server can crash Aman, access the user's files directly, or interfere with other components. Skills that need execution can't run safely.

## Problem

Amanuensis promises to be a personal AI that can *do* things, not just chat. Doing things means running code the model wrote (or the user provided). That code is untrusted by definition — the model can make mistakes, and user-provided scripts can be malicious.

Docker provides the isolation boundary: Linux namespaces for filesystem/process isolation, cgroups for resource limits, and a throwaway container per execution. Without Docker on the machine running Aman, there is no safe way to execute code. The assistant becomes chat-only.

## Goals

1. **Aman can run code:** When the user asks Aman to execute something, it runs in an isolated container (Journeys 1, 2, 3).
2. **Safe by default:** The container has no network, read-only root, and hard memory/CPU/disk limits. The user's host is protected.
3. **MCP and skills are isolated:** MCP servers and code-running skills execute in containers, not as raw host processes (Journey 4).
4. **Zero friction:** The user doesn't configure Docker. If Docker is available, Aman uses it. If not, Aman says so clearly instead of failing mysteriously.
5. **Fast enough:** Container startup doesn't make the user wait noticeably for simple tasks.

## Non-goals

- gVisor (`runsc` runtime). That's PR #55 (spec) and PR #58 (implementation) — a stronger isolation option, separate work.
- Docker setup for the buildbox test environment. (That's operational, not user-facing.)
- Letting the user customize container images or Docker settings. Aman manages this.
- Persistent containers or Docker Compose. Each execution is a fresh, throwaway container.

## Design

### Detection, not requirement

Aman should detect Docker availability at startup. If the Docker socket (`/var/run/docker.sock`) is accessible:

- The sandbox driver initializes normally.
- Tool calls that need execution (`exec`, `run_code`) work.

If Docker is NOT available:

- Aman starts normally (chat, memory, etc. all work).
- When the user asks for something needing execution, Aman says: "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman." Not a crash, not a hang — a clear message with a recovery path.

This is fail-clear, not fail-closed. The user understands the limitation and knows what to do.

### Isolation guarantees

When Docker is available, every code execution gets:

- **Filesystem:** Read-only root, writable scratch area only. The user's files are mounted read-only where needed, never writable.
- **Network:** Disabled by default. No egress. (A separate spec would cover opt-in network access.)
- **Resources:** Hard memory limit, CPU quota, disk quota on scratch, wall-clock timeout.
- **Privileges:** Containers run as non-root user, with minimal Linux capabilities (no `CAP_SYS_ADMIN`, no `CAP_NET_ADMIN`, etc.), and the default seccomp profile.
- **Cleanup:** Container removed after execution. No residue.

### Fail-closed on partial isolation

If Docker is available but any mandatory isolation guarantee cannot be applied (e.g., network cannot be disabled, read-only mount fails, capability drop fails), the execution is REFUSED. Aman tells the user: "I can't run this safely — the sandbox couldn't apply all isolation guarantees." The code is never run with reduced isolation. A partial sandbox is not a sandbox.

### MCP containers vs execution containers

Journeys 1-3 use **ephemeral containers**: created for one execution, removed immediately after. Journey 4 (MCP servers, skills) uses **long-running containers**: started when the MCP/skill is connected, kept alive for the session, with stdio or socket communication to Aman's main process. The isolation guarantees apply to both, but the lifecycle differs. MCP container lifecycle management (start on connect, stop on disconnect, restart on crash) is implementation detail for the MCP integration, not this spec. This spec defines the isolation contract; the MCP layer defines the lifecycle.

### DockerDriver integration

The existing `DockerDriver` currently assumes Docker is available and fails hard if the socket is missing. This spec requires:

1. At Aman startup, a `detectDocker()` check probes `/var/run/docker.sock` accessibility.
2. If accessible: `DockerDriver` initializes as today. No behavior change.
3. If not accessible: `DockerDriver` initializes in "unavailable" mode. Tool calls requiring execution return the "Docker isn't available" message instead of attempting container creation.

The detection happens once at startup, not per tool call.

### gVisor interaction

PR #55 defines `GVisorDriver` with config `SANDBOX_ISOLATION_DRIVER=gvisor`, which wraps `DockerDriver` with `runtime: 'runsc'`. gVisor is a container *runtime*, not a replacement for Docker. If the user configures `gvisor`:

- Docker must still be detected and available (gVisor runs on top of Docker).
- The "Docker isn't available" message still applies if Docker is missing (gVisor can't work without Docker).
- The isolation guarantees in this spec apply, plus gVisor's syscall filtering.

The `SANDBOX_ISOLATION_DRIVER` config chooses the runtime; it does not change the Docker detection requirement.

### No user configuration

The user does not install Docker via Aman, configure the socket path, or manage images. Aman uses the system Docker if present. Docker installation itself is covered by the install documentation (separate from this spec).

## Performance targets

- Container creation + execution overhead under 2 seconds for trivial commands (after image cached).
- Image pull (first run only) is the only slow step; Aman should warn the user on first use.

## Acceptance

1. **Journey 1:** User asks Aman to run a Python script. It executes and returns output. Host filesystem unchanged.
2. **Journey 2:** User provides an untrusted script. It runs in the container. An attempt to access the network fails. An attempt to write outside scratch fails. An attempt to escalate privileges fails (non-root, minimal capabilities).
3. **Journey 3:** User asks for a scraper with dependencies. Container installs them in isolation. User's host Python environment is untouched.
4. **Journey 4:** User connects the Gmail MCP. The MCP server runs in a container. Killing the MCP container does not crash Aman's main process. The MCP cannot access the user's files except through the defined MCP interface.
5. **No Docker:** On a machine without Docker, Aman starts fine. Asking it to run code produces exactly: "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman."
6. **Partial isolation:** If Docker is available but network isolation cannot be applied (simulated), the execution is refused with: "I can't run this safely — the sandbox couldn't apply all isolation guarantees." The code is not executed.

## What this spec explicitly does NOT include

- gVisor or alternative runtimes.
- Buildbox/test environment Docker setup (operational concern).
- User-facing Docker installation flow.
- Network-enabled sandboxes.
- Persistent or reusable containers.

## Decided

- Docker is detected, not required. Aman works without it, but can't execute code.
- Standard socket path only. No configuration options.
- Fail-clear messaging when Docker is missing, not silent degradation.
- This spec is about the user need. Test environment setup is separate.

## Success criteria

- [ ] Journey 1: User's script runs, host untouched.
- [ ] Journey 2: Untrusted script contained, network/filesystem/privilege attacks blocked.
- [ ] Journey 3: Dependencies isolated, host env clean.
- [ ] Journey 4: MCP server isolated, crash doesn't affect Aman.
- [ ] No Docker: Exact message shown, no crash, chat still works.
- [ ] Partial isolation: Execution refused, code not run.
