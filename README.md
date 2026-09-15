<p align="center">
  <img src="./packages/frontend/public/aman-avatar.png" alt="Amanuensis" width="88">
</p>

<h1 align="center">Amanuensis</h1>

Amanuensis (Aman) is a private, local-first AI workbench built on the TrueForge agent harness. It combines a browser chat interface with configurable models, MCP tools, reusable agents and skills, sandboxed execution, session persistence, and Aman-specific personalization and memory features.

This repository is for internal use and active development. It is not a public release or a claim of production readiness.

## Current capabilities

- Streamed, resumable chat sessions with saved agents and folders.
- Configurable model providers, including OpenAI-compatible endpoints; model roles can assign separate models to conversation and auxiliary work.
- MCP connectors with header or OAuth authentication, tool approvals, and per-chat capability selection.
- Reusable `SKILL.md` instruction packs, dynamic subagents, and generative UI.
- On-demand sandbox execution for code and files through the Daytona adapter. Standalone mode also supports a built-in local adapter on supported macOS and Linux hosts; hosted mode needs a configured provider.
- Personas and an inspectable personalization profile.
- Optional host-managed Hindsight memory recall and retention, with bounded recall and reflect calls and auditable recall events.

Capabilities are configurable. A fresh checkout does not include a model, MCP credentials, sandbox credentials, or a memory provider.

## Repository layout

| Path                      | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `packages/trueforge`      | HTTP server, persistence, provider management, and Aman host features |
| `packages/trueforge-core` | Agent runtime, tool orchestration, and session contracts              |
| `packages/frontend`       | Browser application                                                   |
| `packages/trueforge-ui`   | Reusable UI components and server-facing UI contracts                 |
| `packages/trueforge-sdk`  | Generated TypeScript SDK                                              |
| `docs`                    | Product, setup, architecture, and API documentation                   |
| `ops`                     | Aman-specific design records, evaluations, and runbooks               |

## Prerequisites

- Node.js 22.14 or newer
- pnpm 11.16.0 through Corepack (the exact version is pinned in `package.json`)
- Docker with Compose for the hosted topology or smoke test
- A Bash-compatible shell; on Windows, use WSL or Git Bash because root development scripts use POSIX environment-variable assignments

From an existing private-repository checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
cp packages/trueforge/.env.example packages/trueforge/.env
```

## Quick start

For local development with one server process and SQLite:

```bash
pnpm standalone:dev
```

Open `http://localhost:3000`. In a source development checkout, Vite serves the UI on port 3000 and proxies API requests to the server on port 8790; the development server does not serve an unbuilt UI from port 8790. Configure a model under **Settings → Models** before starting a chat. Connectors, skills, a sandbox, and memory are optional and configured separately.

Standalone mode stores SQLite data in the operating system's application-data directory by default. Set `SQLITE_PATH` to use another location; see [`packages/trueforge/.env.example`](packages/trueforge/.env.example) for configuration and defaults.

## Deployment modes

| Mode               | Storage and coordination                                          | Intended use                             | Start command                                                  |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Standalone         | SQLite; one process; no Redis peering                             | Personal development on the same machine | `pnpm standalone:dev`                                          |
| Hosted development | Postgres and Redis from Compose; API and Vite app run on the host | Multi-process development                | `pnpm dev:infra`, then `pnpm dev`                              |
| Hosted Compose     | Containerized server, Postgres, and Redis                         | Integration and deployment evaluation    | `pnpm smoke` or `docker compose up --build`                    |
| Kubernetes         | Helm chart with bundled or external Postgres and Redis            | Managed hosted deployments               | See [`charts/trueforge/README.md`](charts/trueforge/README.md) |

The untracked `packages/trueforge/.env` file created during setup is required by both standalone and hosted server development commands. Review every value before network exposure. The example database credentials are for local development only.

## Security boundaries and limitations

- Standalone mode has no login and ignores OIDC configuration. Keep it bound to localhost.
- Hosted mode also uses a shared admin identity when OIDC is unset. Configure OIDC and appropriate network controls before any shared or internet-facing deployment.
- Tool approval and sandboxing reduce risk; they are not an unlimited safety boundary. Review enabled capabilities, provider trust, egress policy, and approval requests.
- Model credentials stay in the harness. Built-in MCP access from Code Mode is bridged back through the harness so its stored MCP tokens do not enter the sandbox; do not assume the same boundary for arbitrary custom code, tools, or integrations. Administrators remain responsible for secret storage, transport security, and provider configuration.
- Hindsight memory is optional and can retain information across chats. Treat its endpoint and stored data as sensitive; recall screening and live tool-output screening default off.
- The Prompt Guard sidecar under `ops/prompt-guard` is evaluation-only and is not an accepted production security control.

See [authentication](docs/authentication/overview.mdx), [sandboxing](docs/sandbox.mdx), and the [memory runbook](ops/memory/RUNBOOK.md) before enabling those features outside local development.

## Memory

Memory is optional. Amanuensis recalls from a memory provider before every reply and retains every completed turn to it, so the model never has to remember to use it. [Hindsight](ops/memory/RUNBOOK.md) is the recommended provider: a self-hosted, long-term memory bank, run as its own service, with one bank per user. Amanuensis does not bundle Hindsight; run your own instance and point Amanuensis at it.

To connect a bank, go to **Settings → Memory** and add one:

- **URL**: your Hindsight instance's MCP endpoint, shaped `{apiBase}/mcp/{bank}`, naming exactly one bank (for example `https://your-hindsight-host:8449/mcp/your-bank`).
- **Authorization header**: `Bearer <your Hindsight API key>`. Use a key Hindsight accepts on both its MCP endpoint and its REST API. Memory calls the REST API directly for recall and retain; the MCP endpoint and the REST API are two different surfaces, and a key that only works on one leaves recall silently failing (turns fall back to no memory rather than erroring). See [the runbook's two-surfaces note](ops/memory/RUNBOOK.md#two-surfaces-one-connector) if recall stops working after a key rotation.

Two optional Prompt Guard screens can check content around memory before it reaches the model, both off by default:

- **Memory recall screen**: screens memories recalled from the bank before they reach the model. Turn it on per bank in Settings → Memory with the "Screen recalled memories with Prompt Guard" switch; it needs a classifier URL configured and reachable first. Your own stated memories are never withheld; it only applies to memories that came from tools, documents, or email.
- **Tool output screen**: screens tool results before they re-enter model context. This one is environment-only, with no Settings switch, and shares the same classifier URL, token, and threshold as the recall screen.

See [Deployment Security](docs/deployment-security.mdx#prompt-guard-screens) for the full configuration and [Memory design](ops/memory/DESIGN.md) for how recall and retention work.

## Deployment security

The `docker-compose.yml` app port is unauthenticated unless `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are all set; the Postgres and Redis debug ports it publishes are bound to `127.0.0.1` only. See [Deployment Security](docs/deployment-security.mdx) for the full picture: what "everyone is admin without OIDC" means, changing the default Postgres password, the two optional Prompt Guard screens, the always-on sandbox network policy and Spaces iframe restrictions, and the `minimumReleaseAge: 0` supply-chain setting.

## Development and verification

Use root `package.json` scripts for workspace tasks:

```bash
pnpm format:check
pnpm typecheck
pnpm lint:ci
pnpm build
pnpm test
```

`pnpm verify` runs the private-data scan plus all checks above. The Git pre-push hook is change-aware: it always scans the pushed tree for private data, then runs formatting, linting, type checks, or policy tests selected from the changed files. It does not always run the full verification suite.

Useful targeted commands include `pnpm test:trueforge-core`, `pnpm test:trueforge`, `pnpm test:frontend`, and `pnpm smoke`. Read [AGENTS.md](AGENTS.md) and any package-local `AGENTS.md` before changing code. Published-package or frontend changes require a changeset; generated SDK and OpenAPI files are not edited by hand.

## Further reading

- [Introduction and architecture](docs/introduction.mdx)
- [Quickstart and initial configuration](docs/quickstart.mdx)
- [Models and model roles](docs/model-roles.mdx)
- [MCP connectors](docs/mcp-servers.mdx)
- [Memory design](ops/memory/DESIGN.md) and [operations runbook](ops/memory/RUNBOOK.md)
- [Upstream synchronization runbook](docs/UPSTREAM_SYNC.md) and [divergence policy](DIVERGENCE.md)

## Attribution and license

Amanuensis is derived from [TrueForge](https://github.com/truefoundry/trueforge), an open-source agent harness by [TrueFoundry](https://truefoundry.com). Upstream package names, copyright notices, source lineage, and attribution are retained; see [the attribution note](docs/AMANUENSIS_ATTRIBUTION.md).

Licensed under the [MIT License](LICENSE), Copyright 2024–2026 TrueFoundry.
