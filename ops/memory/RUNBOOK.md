# Memory runbook

Two things live here: the Hindsight memory provider, which is what
host-enforced memory runs on, and the LKOS registration script, which wires
LocalKnowledgeOS in as an ordinary retrieval MCP server.

## Hindsight memory provider

Host-enforced memory is an ordinary connector carrying `memory_provider: true`
in its manifest. Exactly one connector may hold the flag. The host recalls from
it before every model call and retains every completed turn; the model is never
responsible for remembering to use it. A shipped catalog preset named
`hindsight` records the URL shape and header auth, with a placeholder host.

### Two surfaces, one connector

The connector URL is Hindsight's MCP endpoint, `{apiBase}/mcp/{bank}`, and it
must name exactly one bank. Memory itself does not speak MCP. It calls the REST
API directly at `POST {apiBase}/v1/default/banks/{bank}/memories/recall`, with
the same resolved headers the connector carries.

Hindsight can be configured so those two surfaces validate different
credentials. When that happens the connector's `auth_status` reads
`authenticated`, because the MCP endpoint accepted the key, while every recall
fails with `HTTP 401 {"detail":"Authentication failed: Invalid API key"}`. A
failed recall degrades the turn to no memory instead of failing it, by design,
so nothing surfaces the breakage except the logs and the per-turn
`aman.memory.recall` events.

The fix belongs in the deployment, not the connector: set
`HINDSIGHT_API_TENANT_API_KEY` to the same value the MCP surface accepts, with
`HINDSIGHT_API_TENANT_EXTENSION` set to the builtin `ApiKeyTenantExtension`, so
one credential satisfies both surfaces.

### The connection check

Every create or replace that leaves `memory_provider: true` on a manifest first
runs one real recall against that REST API, with a trivial query and the
smallest sensible budget. It resolves headers the way a turn does, including
`${env:}` and `${file:}` references and OAuth tokens, and is bounded by
`MEMORY_CHECK_TIMEOUT_MS` (default 5000, deliberately longer than the turn-time
recall timeout so a cold provider is not rejected).

The credential is always the one the row will carry once the write lands, never
whatever it happens to carry now. So an OAuth (`dcr`) manifest is only checked
against a stored token when that token survives the write, meaning an already
authorized OAuth connector saved at an unchanged URL. A new OAuth connector, one
switched over from header auth, and one whose URL is changing (which clears
every token for the row) all report `auth_required` instead of borrowing a
credential that is about to be replaced or deleted.

- Check passes: the write commits.
- Check fails: the write is rejected with 422 and the message carries the upstream reason, for example
  `memory provider check failed: recall returned HTTP 401: Authentication failed: Invalid API key`.
  Nothing is written, so a provider memory cannot reach is never left configured.
- The connector changed while the check ran: the write is rejected with 409 and nothing is written.
  The check runs before the write transaction takes its lock, so a concurrent save can land in
  between; the transaction compares what it is about to commit against what was checked and refuses
  the mismatch. Retry the save.
- Flag absent or false: no check runs and the connector is never dialed.

`POST /api/v1/mcp-servers/{name}/memory-check` re-runs the same check against a
saved connector and changes nothing, so a fixed provider can be re-checked
without toggling the flag off and on. It is the Test control beside the memory
provider badge in connector settings. It answers 200 with `{"data":{"status":"ok"}}`
or `{"data":{"status":"failed","code":...,"reason":...,"http_status":...,"detail":...}}`.

Moving the flag from one connector to another in settings runs that same check
against the candidate first. Only one connector may hold the flag, so the flag
has to be cleared off the incumbent before it can be set on the candidate: a
candidate that fails the check leaves the incumbent alone, and an incumbent that
was already cleared is put back if setting the candidate then fails.

The Test connection control on every configured connector row is a different
check: it dials the MCP endpoint through
`GET /api/v1/mcp-servers/{name}/tools` and reports the tool count or what the
endpoint said. On a memory provider, run both: this one clears the MCP surface,
the memory check clears the REST API.

### Per-bank tuning in Settings > Memory

Everything that shapes what the host reads from a bank is set on the bank's row in Settings >
Memory, under "Memory tuning", and travels on the connector manifest as `memory_settings`. A blank
field keeps the server-wide `MEMORY_*` default, and the form shows that default's actual value in
the blank field (the server reports its resolved defaults under `memory_defaults` in
`GET /api/v1/capabilities`), so an instance with no tuning behaves exactly as its environment says
and nobody has to guess what that is. Fields and bounds (the API rejects anything outside them):

| Field                     | Wire name             | Bounds         | Server default               |
| ------------------------- | --------------------- | -------------- | ---------------------------- |
| Recall timeout (ms)       | `recall_timeout_ms`   | 500 to 120000  | `MEMORY_RECALL_TIMEOUT_MS`   |
| Recall query window       | `recall_query_window` | 1 to 20        | `MEMORY_RECALL_QUERY_WINDOW` |
| Curated layer             | `curated_enabled`     | on, off        | `MEMORY_CURATED_ENABLED`     |
| Mental models per turn    | `curated_max_models`  | 1 to 20        | `MEMORY_CURATED_MAX_MODELS`  |
| Mental model token budget | `curated_max_tokens`  | 64 to 8192     | `MEMORY_CURATED_MAX_TOKENS`  |
| Reflect layer             | `reflect_enabled`     | on, off        | `MEMORY_REFLECT_ENABLED`     |
| Reflect effort            | `reflect_budget`      | low, mid, high | `MEMORY_REFLECT_BUDGET`      |
| Reflect answer token cap  | `reflect_max_tokens`  | 64 to 8192     | `MEMORY_REFLECT_MAX_TOKENS`  |
| Reflect timeout (ms)      | `reflect_timeout_ms`  | 500 to 120000  | `MEMORY_REFLECT_TIMEOUT_MS`  |

Saving the bank still runs the connection check; that check waits at least as long as the bank's
recall timeout, so a bank tuned for a slow provider does not fail its own save. The effective
values for a turn are what the `aman.memory.recall` event reflects.

### Reading a failure

| code                       | What it means                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `invalid_url`              | The connector URL is not `{apiBase}/mcp/{bank}`. Memory would be off for every turn.                          |
| `auth_required`            | An OAuth connector will hold no usable token for this user once the write lands.                              |
| `header_resolution_failed` | An `${env:}` or `${file:}` header reference did not resolve on the server.                                    |
| `timeout`                  | No answer within `MEMORY_CHECK_TIMEOUT_MS`, including a provider that sent headers and then stalled mid-body. |
| `request_failed`           | The host could not reach the provider at all.                                                                 |
| `http_error`               | A non-2xx answer; `http_status` and `detail` carry what the provider said.                                    |
| `invalid_response`         | The answer was unreadable, unparseable, or over `MEMORY_MAX_RESPONSE_BYTES`.                                  |

## LKOS registration script

`scripts/Register-LkosMemory.ps1` wires LKOS (LocalKnowledgeOS) into this TF
Aman deployment as a read-only, retrieval-only remote MCP server. It is a
deliverable for the owner to read and run by hand — it is not executed by any
build, test, or CI step in this change.

Read `ops/memory/DESIGN.md` first for the design this runbook implements
(reference-syntax header auth, the trust classification LKOS's tools must
carry, and the acceptance axes the test suite pins).

### What the script does, gate by gate

Each gate aborts loudly and prints every step completed so far before
exiting non-zero. No gate is skipped or soft-failed.

1. **Certified-binary hash.** `-ExpectedExeHash` is mandatory and is compared
   against `Get-FileHash` of `-LkosExePath`. There is no bypass and no
   default. As of this writing the dossier's recorded hash (`741DA544...`)
   matches none of the LKOS binaries on this machine, so this gate refuses to
   proceed until the owner resolves that (see decision 1 below) and supplies
   the hash of a binary they have actually verified.
2. **Port.** `-Port` is mandatory and must not be `43112` — LKOS's default MCP
   port, which is occupied on this machine by Docker port-forwarding to an
   Amanuensis container. There is no default port; the script refuses `43112`
   by name and requires an explicit alternative (see decision 2 below).
3. **Start + health-probe.** Starts `lkos mcp-http --port <Port>` (plus
   `--allow-host` if `-LkosAllowHost` is set) and polls until it accepts
   connections or `-HealthProbeTimeoutSeconds` elapses. A connection refusal
   the whole timeout window aborts; an HTTP response (even an error status)
   counts as "listening" and passes the probe.
4. **Read-only client registration.** Calls LKOS's web API
   (`register_mcp_client_with_scopes`, via `-LkosRegisterClientEndpoint`) for
   a client scoped to exactly `read` + `source_read`. The returned scope set
   is compared to that exact list — broader **or** narrower — and the script
   aborts rather than wire a client whose grant doesn't match what was asked
   for. The LKOS CLI cannot produce a read-only client at all (see decision 4
   in DESIGN.md); only the web API can, which is why this gate exists.
5. **Token handling.** The returned token is held only in a `SecureString`,
   piped over `docker exec -i <container> sh -c 'umask 077; cat > ... &&
chmod 0600 ...'` stdin (never as a command-line argument, never written to
   this script's own output), and the in-memory plaintext copy is explicitly
   wiped (`ZeroFreeBSTR` + `Remove-Variable` + a `GC.Collect()`) immediately
   after the write. The token is never echoed anywhere in this script's
   output, on success or on failure.
6. **TF registration by reference.** `PUT /api/v1/settings/mcp-servers` with
   `url: http://host.docker.internal:<port>/mcp` and
   `Authorization: ${file:/data/secrets/lkos-token}` — the manifest stores a
   pointer, never the token.
7. **Verification.** `GET`s the manifest back and asserts the stored
   `Authorization` value is still the literal reference string (not a token,
   not something that looks redacted), then calls TF's tools-listing endpoint
   (`GET /api/v1/mcp-servers/<name>/tools`) to prove the reference actually
   resolves and authenticates against the live LKOS server end to end. If TF
   has not yet landed header-reference resolution (the concurrent change this
   runbook was written alongside — `schemas/mcpServer.ts`,
   `runtime/sessionResources.ts`, `utils/secretRedaction.ts`), this call fails
   with an upstream 401: TF would send the literal `${file:...}` string as the
   bearer value instead of the token it points to. That failure is diagnostic,
   not a bug in the script — re-run gate 7 once resolution has landed.

On success the script prints a checklist of every completed gate and leaves
LKOS running in the foreground process it started; it does not install LKOS
as a service or stop it — that is a separate decision for the owner.

### Abort conditions, summarized

| Gate | Aborts when                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `Get-FileHash` of `-LkosExePath` does not match `-ExpectedExeHash`                                                                     |
| 2    | `-Port` is `43112`                                                                                                                     |
| 3    | LKOS exits during startup, or never accepts a connection within the timeout                                                            |
| 4    | The registration call fails, or the granted scopes are not exactly `read` + `source_read`                                              |
| 5    | The `docker exec` write of the token (or the preceding `mkdir -p`) exits non-zero                                                      |
| 6    | TF's `PUT` for the manifest fails                                                                                                      |
| 7    | The stored `Authorization` value is anything other than the literal reference, or the tools-listing call fails, or it lists zero tools |

### Owner decisions this runbook depends on

These are recorded in `ops/memory/DESIGN.md` under "Live-wiring blockers" and
are not something this script or its author can resolve unilaterally:

1. **Which LKOS binary to trust.** The dossier's hash does not match any
   binary found on this machine. The owner must either locate the binary that
   hash actually came from, or rebuild LKOS from pinned source and record the
   fresh hash — then pass it as `-ExpectedExeHash`.
2. **Which port LKOS's MCP endpoint runs on.** `43112` (LKOS's default) is
   taken by an existing Docker port-forward to an Amanuensis container on
   this machine. The owner picks a free port and passes it as `-Port`; the
   script will not guess one.
3. **Whether LKOS needs `--allow-host`.** LKOS validates the loopback
   Host/Origin on incoming requests; requests from the TF container arrive
   with `Host: host.docker.internal:<port>`, which `fetch` cannot rewrite.
   The recommended fix is a small `--allow-host` allowlist flag in LKOS
   itself (the alternative — a host-side proxy that rewrites Host — is worse:
   another moving part, another place for the LKOS bearer token to transit in
   the clear). The owner decides whether that flag exists yet in their LKOS
   build and passes its value as `-LkosAllowHost` (default:
   `host.docker.internal`); if LKOS doesn't support it, leave it empty and
   expect gate 3's health probe to surface the rejection.

### Assumptions to confirm before running

- `-LkosRegisterClientEndpoint` (default `/api/v1/clients/register_with_scopes`)
  names the operation from the dossier (`register_mcp_client_with_scopes`)
  but is not a path confirmed against a specific LKOS build's API reference.
  Confirm it against the installed LKOS version before running, and pass the
  real path via the parameter if it differs.
- `-TrueForgeContainerName` must be the actual running TF Aman container name
  or ID — the script does not discover it for you.
- `-TrueForgeBaseUrl` (default `http://localhost:8000`) and `-TrueForgeApiKey`
  (only needed if TF's admin/settings API has OIDC auth enabled) must match
  this deployment.

## Evaluation-only Prompt Guard sidecar

The classifier assets and reproducible container build live in
`ops/prompt-guard/`. They are not part of the Aman image or startup graph. Read
that directory's README and ADR before running it; the pinned artifact remains
under the Llama 4 license and is not approved as a production control.

Both recall and live tool-output screening use the same classifier connection:

```text
MEMORY_SCREEN_URL=http://<classifier-host>:8080
MEMORY_SCREEN_AUTH_TOKEN=<bearer secret>
MEMORY_SCREEN_THRESHOLD=0.5
```

Recall screening is on or off per the memory bank's `screen_enabled` setting
in Settings > Memory, which defaults to `MEMORY_SCREEN_ENABLED` when the bank
has not set it — so an existing deployment's behaviour does not change until
someone flips the switch. Live tool results are controlled by
`TOOL_OUTPUT_SCREEN_ENABLED` (env only, no per-bank setting) and bounded by
`TOOL_OUTPUT_SCREEN_TIMEOUT_MS` (default 1500). Both default off. Do not
expose the sidecar publicly, do not place the bearer token in Git, and do not
turn on either until the model provenance and local threshold have been
accepted.

The Settings > Memory switch is disabled, with the reason "No screening
service configured", whenever `MEMORY_SCREEN_URL` is unset — flipping it would
have nothing to screen against. The user's own stated memories are never
withheld by the screen; it only checks memories that came from tools,
documents, or email before they reach the model.

The Memory settings page shows:

- recall screening: effective on/off state, whether a classifier service is
  configured, and non-secret threshold only;
- live tool-output screening: on/off state, non-secret threshold, and
  non-secret timeout.

The classifier URL and bearer token remain server-side and are never returned
by `/api/v1/capabilities`.

With live screening enabled, only results marked `open_world_hint: true` are
classified. A withheld result remains expandable in its tool card and its
terminal event carries the screen status. If the classifier is missing,
unreachable, slow, malformed, or oversized, that eligible result fails closed:
the raw output remains visible to the user but does not enter model context.
