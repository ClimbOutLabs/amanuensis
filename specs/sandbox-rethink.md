# Spec: Sandbox Is Docker Only

**Status:** draft (not approved; no implementation beyond the settings page below starts until the owner approves)

**Date:** 2026-10-11

## Problem

Code execution (`run_code`) now runs in a local, offline Docker container, but the Settings > Sandbox page still describes the older world. It mixed two unrelated things without explaining either: the `run_code` sandbox and a "Sandbox providers" section (Daytona or Nightona) with an "Upgrade runtime" card that belonged to the provider. On a Compose deployment whose server cannot reach Docker, the page showed "Isolation status unavailable." and nothing else.

Two causes sat behind that line:

1. The server only reports configuration (`sandbox_isolation` in the capabilities response). It never reports whether Docker, the image and its signature actually work, so the page had nothing live to show.
2. A server with no sandbox image configured reports an empty image. The UI parser rejected an empty image and discarded the whole payload, which is the "unavailable" text.

The owner has decided to offer one sandbox option, Docker. Daytona and Nightona are no longer options.

## Solution

Settings > Sandbox shows only the Docker sandbox:

- what it is, in one line: it runs the Python and Node.js code the assistant writes, in an isolated Docker container with no network access;
- a live status: ready, or off with a plain reason and what to do about it;
- the image and its signature check (downloaded or not, verified or not);
- the limits that matter to a user: time per run, memory, disk space, network off;
- a Re-check action, and a clear error with Try again when the status cannot be fetched.

The Sandbox providers section and the Upgrade runtime card are removed from the page. The settings tab is renamed from "Sandbox providers" to "Sandbox".

A new admin-only route, `GET /api/v1/settings/run-code/status`, runs the isolation driver's readiness probe and returns `{ data: { state, detail? } }`. The page calls it on open and on Re-check.

States, taken from the driver's readiness result and the server configuration:

| State                  | Meaning for the owner                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `ready`                | Code execution is on.                                                                       |
| `not_configured`       | No sandbox image is configured, so code execution is off. Docker is not probed.             |
| `docker_unavailable`   | Docker is not available to the server (for example a server in a container without Docker). |
| `daemon_unavailable`   | Docker is installed but not responding or cannot create containers.                         |
| `image_missing`        | The image is not downloaded yet. It downloads on first use and needs internet access once.  |
| `signature_unverified` | The image signature could not be verified, so the image is not trusted.                     |
| `image_unavailable`    | The image on the machine does not match the configured pinned image.                        |
| `isolation_refused`    | A test sandbox lacked a required protection, so the server refuses to run code.             |
| `unsupported_platform` | The host is not a supported Linux container host.                                           |

Each state has a one-sentence headline, a one-sentence explanation and, where action is needed, a "What to do" line. `detail` carries the driver's own text for states where it adds information, shown under "Technical details".

## Design Decisions

- **Docker is the only sandbox option.** The page offers no provider choice. The provider backend and its APIs are left in place in this change (see Out of Scope).
- **Live status comes from a dedicated route, not from capabilities.** The readiness probe creates and removes containers and runs a canary, so it can take seconds. Capabilities is read at app boot and polled, so it must stay cheap. Configuration (limits, image reference) keeps coming from the existing capabilities field.
- **State is decided on the server.** The driver result gains one optional field, `reason`, so that a signature failure and an isolation refusal are told apart from other failures that share an error code. The mapping lives in one place in `trueforge-core`, next to the status schema, and the UI imports that schema.
- **The host supplies the status call.** The UI package defines a small `RunCodeStatusApi` context, like the other host APIs. The generated SDK and OpenAPI are regenerated elsewhere, so the frontend host calls the route directly and validates the response with the shared schema. The Sandbox tab is shown only when the host provides this API.
- **Advice stays plain; names go under Technical details.** The "What to do" line never names server settings. The full image reference with its digest, the setting names, the limit settings and the driver's own text sit under Technical details. The Image card shows the short name and tag only, and is a list of checks (download, signature) so future sandbox health rows can be added without a redesign. Those rows are not built here.
- **An empty image is valid.** It means no image is configured and is shown as such, not as a parse failure.
- **Never a bare "unavailable".** Every state, and the failed-fetch case, says what happened and what to do.
- **Wire shapes use snake_case**, in line with the rest of the API.

## What Breaks Without a Sandbox Provider

This is read from the current code and is unchanged by this spec. The sandbox the agent sees (shell, files, skills, code mode, and `run_code` itself) is built from a configured provider. `run_code` is a tool of that sandbox, so it is only reachable when a provider resolves.

On a Compose deployment (`STANDALONE=false`, no local fallback) with no provider configured:

- The capabilities response reports the sandbox as disabled, so new default agents start with the sandbox off, and skills are reported unavailable with the reason "Skills run in a sandbox, which is not configured."
- Saving or validating an agent that turns the sandbox on, or that attaches skills, is rejected with a 422 ("sandbox is enabled but no sandbox provider is configured" or "skills require a sandbox provider").
- Starting a turn that needs a sandbox fails with a 422 ("no sandbox provider configured").
- As a result, a working Docker `run_code` sandbox does not make code execution available on its own: no agent can enable it.
- The composer no longer links to a provider form. When the sandbox is unavailable it says so ("The sandbox is not available on this server") and offers no settings link.

On a standalone install, a supported local runtime acts as a built-in provider, so shell and file tools run on the host through it. That path is unaffected.

Resolving this is the point of the follow-up below. Until it lands, an owner who removes the provider option from the page has no way to enable agent sandboxes on Compose.

## Scope

In this change:

- Rewrite Settings > Sandbox as described above, with the status route, the shared status schema, the `reason` field on the driver readiness result, the host API and the tests.
- Rename the settings tab to "Sandbox".
- Remove the code the page no longer uses (the provider form, the runtime-upgrade context and its shell and host props), fix the composer hint, and update `docs/sandbox.mdx`.

Follow-up, not in this change: the shell, file and coding tools move into Docker through a broker, so they no longer need a sandbox provider and `run_code` no longer depends on one. That work removes the dependency described in the previous section. It needs its own spec.

## Privacy

- Nothing about user content is involved. The status route returns a state and, for some failures, the driver's diagnostic text (for example cosign or canary output). The cosign key path and host run paths are already redacted by the driver before the text leaves it.
- The route is admin-only, under the settings mount.
- Code still runs locally in Docker with no network access, and nothing is sent to a hosted sandbox. Configuration values shown (image reference, limits) are non-secret.
- The readiness probe stages and deletes a throwaway canary run on the server; it never touches user files.

## Testing (synthetic data)

All tests use synthetic data and fake drivers or fetchers; none needs Docker or the user's real data.

- Core: the readiness-to-status mapping for every state, and the driver's `reason` for a signature failure and an isolation refusal.
- Server: the status route for not configured (Docker not probed), ready, Docker unavailable, signature failure, and a probe that throws (500).
- UI: the page's text for each state, image and signature rows, limits, Re-check, the loading state, and the failed-fetch error with Try again; the Sandbox tab shown only when the host provides the status API; the capability reader accepting an empty image.
- Frontend host: the status client reads the route, surfaces server errors, and rejects an unknown state.
- Screenshots in dark and light themes for Docker unavailable, ready and signature not verified.

## Out of Scope

- The broker that moves shell, file and coding tools into Docker, and any change to how agents obtain a sandbox.
- Deleting the provider backend, its settings and catalog APIs, the upgrade-image route and the UI provider catalog adapter. They stay for now and go in a separate provider removal change.
- Docs outside `docs/sandbox.mdx` that still describe configuring a provider (the quickstart and initial setup pages). They go with the provider removal change.
- Changing sandbox limits from the page. They stay server configuration and need a restart.
- A "download image now" action, Windows support, and the Firecracker driver.
