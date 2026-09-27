<p align="center">
  <img src="./packages/frontend/public/aman-avatar.png" alt="Aman, the Amanuensis scribe, writing with a quill" width="180">
</p>

<h1 align="center">Amanuensis</h1>

<p align="center">
  <em>A private, local-first AI workbench. Your models, your tools, your memory — on your machine.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.14-brightgreen.svg" alt="Node.js >= 22.14">
  <img src="https://img.shields.io/badge/pnpm-11.16_via_Corepack-orange.svg" alt="pnpm 11.16 via Corepack">
  <img src="https://img.shields.io/badge/local--first-blue.svg" alt="local-first">
</p>

<p align="center">
  <a href="docs/quickstart.mdx"><strong>Quickstart</strong></a> &nbsp;·&nbsp;
  <a href="docs/introduction.mdx">Introduction</a> &nbsp;·&nbsp;
  <a href="docs/deployment-security.mdx">Deployment security</a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="./packages/frontend/public/readme-hero.png" alt="Amanuensis after sign-in: the New Chat screen with the left navigation rail, an empty chat history, the message composer with a model selector, and the assistant panel on the right" width="850">
</p>

Amanuensis (Aman) is a private, local-first AI workbench built on the TrueForge agent harness. It combines a browser chat interface with configurable models, MCP tools, reusable agents and skills, sandboxed execution, session persistence, and Aman-specific personalization and memory features.

## ✨ Features

- 💬 **Streamed, resumable chat** — sessions organized with saved agents and folders.
- 🧠 **Your choice of model** — configurable providers, including OpenAI-compatible endpoints and fully local Ollama; model roles assign separate models to conversation and auxiliary work.
- 🔌 **MCP connectors** — header or OAuth authentication, tool approvals, and per-chat capability selection.
- 📦 **Reusable skills and subagents** — `SKILL.md` instruction packs, dynamic subagents, and generative UI that renders interactive results instead of plain text.
- 💻 **Sandboxed execution** — on-demand code and file execution through the Daytona adapter; standalone mode also supports a built-in local adapter on macOS and Linux hosts.
- 👤 **Personalization** — personas and an inspectable personalization profile.
- 🗄️ **Long-term memory** — on by default as local Markdown files: the model retains what matters from each chat and recalls it in later ones, with bounded recall and auditable recall events. Self-hosted Hindsight banks remain available as an experimental opt-in.

Capabilities are configurable. A fresh checkout does not include a model, MCP credentials, or sandbox credentials — memory works out of the box with local Markdown files.

## 🏗️ Architecture

```mermaid
flowchart TB
    Browser["Browser chat UI<br/>(packages/frontend)"]
    Server["TrueForge server<br/>HTTP API · auth · streaming<br/>(packages/trueforge)"]
    Runtime["Agent runtime<br/>tool orchestration · approvals · sessions<br/>(packages/trueforge-core)"]
    Models["Model providers<br/>OpenAI-compatible · Ollama"]
    MCP["MCP connectors<br/>header / OAuth auth"]
    Sandbox["Sandbox<br/>Daytona · local adapter"]
    Memory["Memory<br/>Markdown files (local)"]
    Storage[("Storage<br/>SQLite in standalone<br/>Postgres + Redis hosted")]

    Browser --> Server --> Runtime
    Runtime --> Models
    Runtime --> MCP
    Runtime --> Sandbox
    Runtime --> Memory
    Server --> Storage

    style Browser fill:#e8f4ff,stroke:#4a9eff
    style Runtime fill:#fff7e8,stroke:#e8a13d
    style Storage fill:#eef7ee,stroke:#5aa65a
```

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

## Quick start

> **Install from a release, not from main.** The commands below pin the latest stable release. For the newest stable release, see [Releases](https://github.com/ClimbOutLabs/amanuensis/releases). The `main` branch is active development and may be unstable.

The fastest path to a working chat is standalone mode: one process on your own machine, SQLite storage, no Docker, no login screen. You need [Node.js](https://nodejs.org/en/download) 22.14 or newer and pnpm 11.16.0 through [Corepack](https://pnpm.io/installation#using-corepack) (the exact version is pinned in `package.json`); on Windows, run these from [WSL](https://learn.microsoft.com/windows/wsl/install) or [Git Bash](https://git-scm.com/downloads/win):

```bash
git clone --branch v0.1.0 https://github.com/ClimbOutLabs/amanuensis && cd amanuensis
corepack enable
pnpm install --frozen-lockfile
cp packages/trueforge/.env.example packages/trueforge/.env
pnpm standalone:dev
```

Open `http://localhost:3000`. The app ships with no model configured — connect one under **Settings → Models** before starting a chat.

The server runs without a file watcher (on some Windows machines the watcher stalls before the server starts), so restart `pnpm standalone:dev` to pick up backend changes — the UI itself still hot-reloads.

[docs/quickstart.mdx](docs/quickstart.mdx) walks through this path in full: prerequisites, connecting your first model (a hosted API key or a fully local Ollama model), confirming a chat works, and troubleshooting the failures a fresh install actually hits.

## Docker Compose (production path)

When you're ready to run Aman as a shared service instead of a personal install. This is the production topology — the server containerized, Postgres replacing SQLite as durable storage, and Redis so streams and cancellations follow the client across server replicas — with no Node.js or pnpm needed on the host. Choose it when the app needs to serve more than just you, or when you want to evaluate a deployment.

The app is single-user and, as shipped, this stack has no login screen: every port is bound to `127.0.0.1`, and whoever reaches port `8791` is the admin. The stack's `login` profile adds a real sign-in screen with an account you define, and needs no external identity provider; turn it on before anyone but you can reach the app (see [Deployment Security](docs/deployment-security.mdx)).

```bash
git clone --branch v0.1.0 https://github.com/ClimbOutLabs/amanuensis && cd amanuensis
cp packages/trueforge/.env.example packages/trueforge/.env
docker compose up --build
```

The first build takes several minutes. `docker compose up` keeps streaming container logs in the foreground; the stack is ready when the `server` line `Agent server listening on http://0.0.0.0:8790` appears. Open `http://localhost:8791`.

**Turn on login.** Generate a client secret and a password hash, uncomment the **Compose login profile** block in `packages/trueforge/.env`, fill in the values it names (the hash stays inside its single quotes), then start the stack with the profile. From then on, always start it with the profile.

```bash
openssl rand -hex 32
docker run --rm httpd:2.4-alpine htpasswd -nbBC 10 "" 'your-password' | cut -d: -f2
docker compose --profile login up --build
```

Open `http://localhost:8791` and click **Let's Get Started**. The identity provider runs at `https://localhost:5556` with a certificate the stack minted on first start, so the browser warns once: choose **Advanced**, proceed to localhost, and sign in with the email and password you chose.

<p align="center">
  <img src="./packages/frontend/public/compose-get-started.png" alt="The first screen of a Compose stack with login on: the Amanuensis logo, the heading Welcome to Amanuensis, and a Let's Get Started button" width="420">
  <img src="./packages/frontend/public/compose-login.png" alt="The Dex sign-in form the button leads to: an Email Address field, a Password field, and a Login button" width="420">
</p>

You land in **Settings → Models** as that user, with your name at the bottom of the navigation rail. Connect a model there before starting a chat; nothing is configured on a fresh stack.

<p align="center">
  <img src="./packages/frontend/public/compose-signed-in.png" alt="Signed in: Settings open on the Models page, listing model providers each with a Configure button, the signed-in user shown at the bottom of the left rail, and the assistant panel on the right" width="850">
</p>

The layout adapts to a phone-width window:

<p align="center">
  <img src="./packages/frontend/public/mobile-login.png" alt="The Dex sign-in form at phone width" width="260">
  <img src="./packages/frontend/public/mobile-new-chat.png" alt="The New Chat screen at phone width: a menu button, the How can I help you today prompt, notices that no model and no memory bank are chosen, and the message composer" width="260">
</p>

See the [quickstart's Docker Compose section](docs/quickstart.mdx#other-ways-to-run-it) for the details that differ on this path (ports, environment, the login profile in full, reaching a host-run Ollama from the container).

## Deployment modes

| Mode               | Storage and coordination                                          | Intended use                                          | Start command                                                  |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Standalone         | SQLite; one process; no Redis peering                             | Recommended install; personal use on the same machine | `pnpm standalone:dev`                                          |
| Hosted Compose     | Containerized server, Postgres, and Redis                         | Production path; shared deployments                   | `docker compose up --build` (`--profile login` for sign-in)    |
| Hosted development | Postgres and Redis from Compose; API and Vite app run on the host | Multi-process development                             | `pnpm dev:infra`, then `pnpm dev`                              |
| Kubernetes         | Helm chart with bundled or external Postgres and Redis            | Managed hosted deployments                            | See [`charts/trueforge/README.md`](charts/trueforge/README.md) |

The untracked `packages/trueforge/.env` file created during setup is required by both standalone and hosted server development commands. Review every value before network exposure. The example database credentials are for local development only.

## Security boundaries and limitations

- Standalone mode has no login and ignores OIDC configuration. Keep it bound to localhost.
- Hosted mode also uses a shared admin identity when OIDC is unset. Configure OIDC (the Compose `login` profile, or your own identity provider) and appropriate network controls before any shared or internet-facing deployment.
- Tool approval and sandboxing reduce risk; they are not an unlimited safety boundary. Review enabled capabilities, provider trust, egress policy, and approval requests.
- Model credentials stay in the harness. Built-in MCP access from Code Mode is bridged back through the harness so its stored MCP tokens do not enter the sandbox; do not assume the same boundary for arbitrary custom code, tools, or integrations. Administrators remain responsible for secret storage, transport security, and provider configuration.
- Markdown memory stores memories as plain files under `MEMORY_MARKDOWN_DIR` (default `./data/memory`) — treat that directory as sensitive. Recall screening and live tool-output screening default off.
- The Prompt Guard sidecar under `ops/prompt-guard` is evaluation-only and is not an accepted production security control.

See [authentication](docs/authentication/overview.mdx), [sandboxing](docs/sandbox.mdx), and the [memory runbook](ops/memory/RUNBOOK.md) before enabling those features outside local development.

## How memory works

Aman remembers things between conversations so you don't have to repeat yourself. Here is the plain-English version of how that works — the technical details live in [Memory](#memory) below.

**Memories are ordinary files.** Aman saves what matters from your conversations as plain text files (Markdown) on the server, in its memory folder (by default, `./data/memory` next to the server). There is no database to manage and nothing locked away: the files are human-readable, and they're yours.

**After each chat, Aman writes a short summary.** Instead of keeping every turn word for word, Aman distills each conversation down to the important details — decisions, facts about you, things to follow up on — and saves that. This keeps the memory folder small and useful. If you'd rather keep the full transcript of every turn instead, flip the **Turn summaries** switch off in **Settings → Memory**; new turns are then saved verbatim. Either way, if summarizing ever fails, Aman keeps the full transcript as a fallback, so nothing is lost.

**Aman finds memories by meaning, not just words.** When you ask something, Aman searches your memories for meaning — so "where did we stay in Madrid" finds the hotel note even though it says "Petit Palace" and never mentions Madrid. To do that, the first time Aman runs it downloads a small helper model once (about 120 MB), automatically in the background: the download starts when the server starts, so it's usually finished before you need it. There is nothing to install and nothing to click. After that one download, memory search works fully offline, and everything stays on this server. If the download can't finish, Aman just keeps finding memories with keywords, and keeps retrying in the background.

**Keep the memory folder safe.** The downloaded helper model lives inside the memory folder too, so they travel together. If you run Aman with Docker, make sure the memory folder is stored on a persistent volume: without one, your memories — and the downloaded model — disappear whenever the container is recreated.

## Memory

Memory is on by default. Amanuensis recalls from local Markdown files before every reply and retains what matters from each completed turn, so the model never has to remember to use it. Memories live as plain files under `MEMORY_MARKDOWN_DIR` (default `./data/memory`, relative to the server's working directory) — human-readable, portable, and yours. In Docker, mount a volume at that path so memories survive container recreates.

Manage it in **Settings → Memory**: see what's stored, turn recall on or off (the rail toggle does the same), and check the memory status. Recall is bounded, so a large memory can't blow up the model's context window, and every recall is auditable.

Prefer a hosted memory bank? Set `MEMORY_BACKEND=hindsight` to use a self-hosted [Hindsight](ops/memory/RUNBOOK.md) instance instead — currently experimental. Point Amanuensis at your bank's MCP endpoint (`{apiBase}/mcp/{bank}`) with a `Bearer` API key in **Settings → Memory**. Memory calls Hindsight's REST API directly for recall and retain, so use a key valid on both surfaces; see [the runbook's two-surfaces note](ops/memory/RUNBOOK.md#two-surfaces-one-connector) if recall stops working after a key rotation.

Two optional Prompt Guard screens can check content around memory before it reaches the model, both off by default:

- **Memory recall screen**: screens memories recalled from the bank before they reach the model. Turn it on per bank in Settings → Memory with the "Screen recalled memories with Prompt Guard" switch; it needs a classifier URL configured and reachable first. Your own stated memories are never withheld; it only applies to memories that came from tools, documents, or email.
- **Tool output screen**: screens tool results before they re-enter model context. This one is environment-only, with no Settings switch, and shares the same classifier URL, token, and threshold as the recall screen.

See [Deployment Security](docs/deployment-security.mdx#prompt-guard-screens) for the full configuration and [Memory design](ops/memory/DESIGN.md) for how recall and retention work.

## Deployment security

The `docker-compose.yml` app port is unauthenticated unless `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are all set (the `login` profile sets them against its bundled Dex); the Postgres and Redis debug ports it publishes are bound to `127.0.0.1` only. See [Deployment Security](docs/deployment-security.mdx) for the full picture: what "everyone is admin without OIDC" means, changing the default Postgres password, the two optional Prompt Guard screens, the always-on sandbox network policy and Spaces iframe restrictions, and the `minimumReleaseAge: 0` supply-chain setting.

## Development and verification

Use root `package.json` scripts for workspace tasks:

```bash
pnpm format:check
pnpm typecheck
pnpm lint:ci
pnpm build
pnpm test
```

`pnpm verify` runs the secret scan plus all checks above. The Git pre-push hook is change-aware: it always scans the pushed tree for private data, then runs formatting, linting, type checks, or policy tests selected from the changed files. It does not always run the full verification suite.

Useful targeted commands include `pnpm test:trueforge-core`, `pnpm test:trueforge`, `pnpm test:frontend`, and `pnpm smoke`. Read [AGENTS.md](AGENTS.md) and any package-local `AGENTS.md` before changing code. Generated SDK and OpenAPI files are not edited by hand.

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
