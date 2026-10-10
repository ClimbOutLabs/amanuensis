# Memory runbook

This runbook covers the Hindsight memory provider, which is what
host-enforced memory runs on, and the evaluation-only Prompt Guard sidecar
that can screen recall and tool output.

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

### First-party status

Saving a connector as the memory provider, once the check above passes, also marks
it first-party on the server. The mark lives on the stored connector, never in the
manifest, and no request can set it. On a first-party connector a tool that
declares itself read-only and explicitly closed-world (`readOnlyHint` true and
`openWorldHint` false) runs without an approval card, and each run is recorded in
the audit log. Everything else keeps asking.

Saving the connector with a different URL, or without `memory_provider`, clears the
mark. A save that keeps `memory_provider: true` at the same URL keeps it. To get it
back after moving the connector, save it once without the flag and once more with
it. Connectors saved before the mark existed start without it, so do the same for
an existing memory provider to turn it on.

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
