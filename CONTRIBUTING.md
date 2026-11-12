# Contributing to Amanuensis

Thanks for your interest in contributing! This document covers how to set up a development environment, run the test suites, and open a pull request.

Amanuensis is a personal project maintained by its author. Bug reports and docs improvements are the most helpful contributions. By contributing you agree that your contributions are licensed under the [Mozilla Public License 2.0](LICENSE).

## Code contributions

External code contributions are paused until a contributor agreement is in place, so that the project can offer other licenses later. Bug reports and issues are welcome in the meantime.

## Ways to contribute

- **Report bugs** — open an issue with steps to reproduce, expected vs actual behavior, and your environment.
- **Improve docs** — typo fixes and clarifications are always welcome.
- **Fix bugs / build features** — for anything non-trivial, open an issue first so the approach can be discussed before you invest time.

For security vulnerabilities, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

### Reporting bugs

Before opening a new issue, search the issue tracker to see whether the problem has already been reported. If it has, add any new information to the existing issue.

When reporting a bug, include as much relevant detail as possible:

- Clear, detailed steps to reproduce the problem.
- Expected and actual behavior.
- Your Amanuensis version, operating system, and other relevant environment details.
- Logs, error messages, or other diagnostic information, with sensitive information removed.
- Root-cause analysis, technical observations, or potential approaches to a fix, if available.

### Requesting features

Open a feature request in the issue tracker, or upvote an existing request that describes the same need. Explain your use case, the behavior you would like, and why it would improve your workflow.

## Prerequisites

Source development (`pnpm install`, `pnpm dev`, `pnpm standalone:dev`, `pnpm build`) is supported on **macOS, Linux, and Windows via WSL2**. Native Windows (PowerShell / cmd) is not a supported at this time.

- **Node.js 22.14+** (see [`.nvmrc`](.nvmrc); pnpm 11.16 needs 22.13+, and `better-sqlite3` v13 needs Node-API 10)
- **pnpm** (version pinned via `packageManager` in [`package.json`](package.json); `corepack enable` handles it)
- **Docker** - only needed for Postgres/Redis dev infra, the smoke test, and local SDK generation (maintainers). Fork contributors do not generate the SDK.

## Repository layout

This is a pnpm workspace:

| Workspace package             | Published as                  | Path                                                 | What it is                                   |
| ----------------------------- | ----------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `@truefoundry/trueforge`      | `@truefoundry/trueforge`      | [`packages/trueforge`](packages/trueforge)           | Agent server + bundled UI                    |
| `@truefoundry/trueforge-core` | `@truefoundry/trueforge-core` | [`packages/trueforge-core`](packages/trueforge-core) | Library: agent core, sessions, and streaming |
| `@truefoundry/trueforge-ui`   | `@truefoundry/trueforge-ui`   | [`packages/trueforge-ui`](packages/trueforge-ui)     | Embeddable agent chat UI SDK                 |
| `@truefoundry/trueforge-sdk`  | `@truefoundry/trueforge-sdk`  | [`packages/trueforge-sdk`](packages/trueforge-sdk)   | Generated TypeScript API client              |
| `frontend`                    | -                             | [`packages/frontend`](packages/frontend)             | Chat UI app (bundled into the server)        |

## Setup

```bash
pnpm install
cp packages/trueforge/.env.example packages/trueforge/.env
```

## Running from source

There are two dev topologies. Both serve the UI on [http://localhost:3000](http://localhost:3000) (Vite, with live reload, proxying `/api/*`) and the API on [http://localhost:8790](http://localhost:8790).

### Standalone (zero infra)

SQLite only - good for most day-to-day development. Standalone mode is intended for local use; it is not a production-safe topology (local SQLite). Please do not expose it beyond localhost. Login is mandatory: run `pnpm dev:login` in a second terminal (needs Docker), add the `OIDC_*` lines it prints and `PUBLIC_BASE_URL=http://localhost:3000` to `packages/trueforge/.env`, then:

```bash
pnpm standalone:dev
```

### Multi-replica (Postgres + Redis)

Use this when working on anything involving Postgres storage or Redis peering (cross-replica turn cancels and stream handoff).

Terminal 1 - start Postgres (`:5432`) and Redis (`:6379`):

```bash
pnpm dev:infra
```

Terminal 2:

```bash
pnpm dev
```

|           | Standalone                             | Multi-replica                                   |
| --------- | -------------------------------------- | ----------------------------------------------- |
| Process   | One server                             | One or more replicas with Redis peering         |
| Database  | SQLite                                 | Postgres                                        |
| Infra     | None                                   | Postgres + Redis (`pnpm dev:infra` or your own) |
| Dev       | `pnpm standalone:dev`                  | `pnpm dev` (after infra)                        |
| Prod-like | `pnpm build` → `pnpm standalone:start` | `pnpm build` → `pnpm start`                     |

Local server scripts resolve `@truefoundry/trueforge-core` from source, so you do not need a trueforge-core `dist/` build for `pnpm dev` / `standalone:dev`. Frontend scripts build `@truefoundry/trueforge-ui` `dist/` before Vite starts (workspace package exports point at `dist/`).

### How the UI is served

Dev and production-like runs use different process topologies. Standalone vs multi-replica only changes storage/peering (`STANDALONE`); it does not change how the UI is served.

**Development** - `pnpm standalone:dev` / `pnpm dev` run two processes in parallel: Vite (UI, with live reload) and the Hono API. The browser talks to Vite; Vite proxies `/api/*` to Hono.

```
  browser                     Vite (:3000)                   Hono (:8790)
     │                             │                              │
     │  GET /  (UI)                │                              │
     │────────────────────────────>│                              │
     │                             │                              │
     │  /api/*                     │  proxy                       │
     │────────────────────────────>│─────────────────────────────>│
```

**Production-like** - after `pnpm build`, `pnpm standalone:start` / `pnpm start` run a single Hono process. It serves the built frontend bundle for non-API routes and handles `/api/*` itself. The Docker container works the same way: one process, one origin.

```
  browser                                    Hono (:8790)
     │                                            │
     │  GET /  (static UI from dist/_frontend)    │
     │───────────────────────────────────────────>│
     │                                            │
     │  /api/*                                    │
     │───────────────────────────────────────────>│
```

On one origin (start / Docker): `/api/*` (including OpenAPI) and `/healthz` are the API; everything else is the UI. The server prefers a packaged `dist/_frontend`, then `packages/frontend/dist`. With no UI build present it serves the API only (normal for Vite-backed `pnpm dev`).

### Configuration

See [`packages/trueforge/.env.example`](packages/trueforge/.env.example) for every env var. Useful dev overrides:

- `PORT` - API port (default `8790`)
- `FRONTEND_PORT` - Vite UI port in dev (default `3000`); see [`packages/frontend/README.md`](packages/frontend/README.md)
- `VITE_SERVER_URL` - point the Vite proxy at a different API
- `PUBLIC_BASE_URL` - public application URL for MCP OAuth / OIDC callbacks. Required for distributed mode and for `pnpm dev` (e.g. `http://localhost:3000` for Vite). Standalone takes an origin with no path and falls back to `http://localhost:$PORT` when unset.
- `ALLOWED_ORIGINS` - standalone only: comma-separated origins the app may be opened at (http only for loopback and private networks, https otherwise). Sign-in returns to the origin of the request when it is listed, the app passes the issuer's path through, and any other address gets a plain 400. Unset keeps the single `PUBLIC_BASE_URL` origin.
- `LOGIN_UPSTREAM_URL` - standalone only: where the sign-in service listens on this computer (loopback http with the issuer path), for an instance whose issuer is a public https address. The app then serves the issuer address's `/dex` pages itself, with a limit on password guessing; the reverse proxy must set `X-Forwarded-For`.
- `TRUSTED_PROXY_ADDRESSES` - standalone only: comma-separated IP addresses of a reverse proxy, besides this computer's own, whose `X-Forwarded-For` is believed when limiting password guessing per visitor.
- `AUTH_COOKIE_SUFFIX` - suffix on every auth cookie name; set a distinct value per instance sharing a hostname
- `FRONTEND_DIR` - directory of a built UI for the server to serve
- `SQLITE_PATH` - SQLite file location in standalone mode
- `REDIS_URL` / `POSTGRES_*` - used when `STANDALONE=false`

### Migrations

Migrations run on server startup. To run Postgres migrations without starting HTTP:

```bash
pnpm --filter @truefoundry/trueforge migrate
```

That script sets `STANDALONE=false` and uses `POSTGRES_*` from `packages/trueforge/.env`. It will not run in standalone mode (SQLite migrations happen on boot instead).

## Workspace scripts

Workspace tasks go through `package.json` scripts - if a repeatable workflow is missing, add a script rather than documenting an ad hoc command.

| Script                                               | Purpose                                               |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `pnpm standalone:dev` / `pnpm dev`                   | Local UI + API (see modes above)                      |
| `pnpm standalone:dev:no-watch` / `pnpm dev:no-watch` | Same, but the server does not restart on file changes |
| `pnpm dev:server:ui`                                 | Packed UI + watched API (no Vite)                     |
| `pnpm build`                                         | Build all packages                                    |
| `pnpm test` / `pnpm typecheck`                       | Workspace checks                                      |
| `pnpm lint` / `pnpm format`                          | ESLint (with fixes) / Prettier                        |
| `pnpm smoke` / `pnpm smoke:down`                     | Full Docker Compose stack + health check              |
| `pnpm smoke:npx`                                     | Pack the published CLI and boot it like `npx`         |
| `pnpm smoke:npx:amanuensis`                          | Pack `amanuensis` and start it with `npx`; CI runs it |
| `pnpm chart:lint` / `pnpm chart:template`            | Validate the Helm chart                               |
| `pnpm clean` / `pnpm clean:all`                      | Remove build outputs (+ `node_modules` for `:all`)    |

## Testing

```bash
pnpm test         # unit tests across all packages
pnpm typecheck    # TypeScript across all packages
pnpm lint         # ESLint
pnpm format:check # Prettier
```

### Store contract tests

Storage-layer changes should pass both store suites (CI runs them when store paths change):

```bash
pnpm --dir packages/trueforge test:store:sqlite
pnpm test:store:local   # Postgres suite against local infra
```

### Smoke test (Docker)

Full stack in containers - the built server image serves API + UI, in multi-replica mode (`STANDALONE=false`):

```bash
pnpm smoke       # build, wait for healthy services, check /healthz and UI
pnpm smoke:down
```

Open [http://localhost:8791](http://localhost:8791). Credentials come from `packages/trueforge/.env`. The app is on host `:8791` (offset from local `pnpm dev` on `:8790`); Postgres and Redis stay on the compose network only.

## Generated code - do not edit by hand

- [`packages/trueforge-sdk`](packages/trueforge-sdk), [`.github/fern/openapi/openapi.json`](.github/fern/openapi/openapi.json), and [`docs/openapi.json`](docs/openapi.json) are generated and committed. Edit route handlers under `packages/trueforge/src/routes/` instead; CI regenerates the outputs. To regenerate locally (Docker required): `pnpm sdk:generate`.
- Catalog YAML files under `packages/trueforge/catalog/` are inlined at build time by `build:gen` scripts.
- The help pack behind **Help, I'm stuck** (`packages/trueforge/src/personas/amanGuide/knowledgePack.generated.ts`) is built from the guide topics, the public docs pages and the Tour cards. Run `pnpm guide:build` and commit the result; CI runs `pnpm guide:check` and fails when it is stale. See [`packages/trueforge/guide/README.md`](packages/trueforge/guide/README.md).

## Server entry points

| File           | Used by                                       | Role                                        |
| -------------- | --------------------------------------------- | ------------------------------------------- |
| `dist/main.js` | Docker, `pnpm start`, `pnpm standalone:start` | Env-only server boot                        |
| `dist/cli.js`  | `npx @truefoundry/trueforge`                  | CLI (`--help`, `--port`), then loads `main` |

## Coding conventions

The repository-wide rules live in [`AGENTS.md`](AGENTS.md) (some packages have their own nested `AGENTS.md`). Highlights:

- No type-assertion escapes (`as T`, non-null `!`) to silence errors - fix the types.
- Wrap-and-rethrow must preserve the original error via `{ cause }`.
- Zod-backed types are derived with `z.infer<typeof Schema>`; don't duplicate schemas as interfaces.
- Static `import` / `import type` only - no `require()`.
- Tests live under a top-level `test`/`tests` directory mirroring `src`, never inline.
- Wire shapes (HTTP/OpenAPI) and database identifiers use `snake_case`.
- Server env reads go through `packages/trueforge/src/config.ts`, never `process.env` directly.
- Remove dead code in the same change that makes it dead.

Prettier and ESLint run as pre-commit hooks via husky + lint-staged.

## Pull requests

1. Fork (or branch) and create a topic branch: `git checkout -b my-fix`.
2. Make your change, with tests where it makes sense. Do not commit generated OpenAPI/SDK output (forks: source only; `main` regenerates after merge).
3. Make sure `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint:ci`, and `pnpm format:check` pass. CI also runs the root script tests (`pnpm test:repo-policy`, `pnpm lint:theme` and the other root `test:*` scripts), the layout rules (`pnpm check:repo-rules`), a check that the PR adds no `as T` or non-null `!` assertions (`pnpm check:new-assertions`), and, when `installer/` changes, `pnpm lint:installer` and `pnpm test:installer`.
4. If the PR changes a screen people see, update the help topic that covers it under `packages/trueforge/guide/topics`. When no topic needs to change, add the label `help: no change needed` and say why in the PR. The **Help changed with screens** check enforces this.
5. Keep PRs focused and reasonably small; describe **what** changed and **why** in the description.
6. Keep the description, commit messages and added lines free of AI-tool attribution: no generated-by footers, no AI `Co-Authored-By` or session trailers, and no links to private assistant workspaces. Leave out privacy or license checklists too; CI checks dependency licenses. The **PR hygiene** check fails on any of these and runs again when you edit the description.
7. Open the PR. The maintainer will review it; squash-merge is the norm.
8. **Please avoid rebasing or force-pushing once a maintainer has started reviewing.** It can make iterative reviewing harder. To update your branch, merge `main` instead. We squash-merge at the end, so messy in-PR history is fine.

## Nightly run

A pull request runs only the test suites its changed files select. The **Nightly** workflow ([`.github/workflows/nightly.yml`](.github/workflows/nightly.yml)) runs every suite on `main` each night, including all the browser tests, whatever changed that day. It reuses the CI workflow, so a suite added to CI is in the nightly run too.

- When a nightly run fails, it opens an issue titled **Nightly tests failed** that lists the failed jobs and links the run. Later failures are added to the same issue. The next run that passes closes it. A cancelled run changes nothing.
- To start a run by hand, open the **Actions** tab, pick **Nightly**, and choose **Run workflow**. A run started on a branch other than `main` does not open or close the issue.
- The run uses a scripted model and needs no keys or accounts.

### Every feature names its test

[`tests/nightly-coverage.json`](tests/nightly-coverage.json) lists every feature: the Settings panels, approval cards, email and calendar presets, Home cards, installer commands and server route groups read from the code, plus the screens listed by hand under `screens`. Each row gives the feature's feature set (Chat, Memory, Reminders and so on) and the tests that exercise it. `pnpm nightly:coverage` prints how many features have a test and fails when:

- a feature has no row, or a row names a feature that is gone;
- a named test does not exist, or never mentions the feature's id;
- a feature with no test is missing from `not_yet`.

When you add a feature, add its row and its test in the same PR. Add it to `not_yet` only when the test truly cannot land yet, and say why in the PR.

### Screenshots

Browser tests save a picture at each named step with `featureShotPath({ surface, step })` from [`packages/frontend/tests/support/featureShots.ts`](packages/frontend/tests/support/featureShots.ts). The feature's id picks the folder, so pictures land in one folder per feature set. A failing test saves a picture of every open page with `FAILED` in its name.

In CI the pictures go in a folder named for the run's date and time in UTC, such as `2026/11/10/0917/chat/`. The folder gets an `index.html` contact sheet and a `results.json`, and the run keeps it for 30 days as the **screenshots** download on the run's page. To see the same on your machine:

```bash
AMAN_SCREENSHOT_DIR=/tmp/aman-shots pnpm test:frontend
pnpm nightly:gallery /tmp/aman-shots
```

### The signed-in journey

`pnpm test:journey` runs one person's first hour on the built app, the way an installed Aman runs: sign in through the real sign-in service (Dex), land on first run, add a model in Settings, chat, come back to the chat, and sign out. The test is [`packages/frontend/tests/journeys/signedIn.journey.ts`](packages/frontend/tests/journeys/signedIn.journey.ts). CI runs it on every pull request and every night, right after the build, and its pictures join the same **screenshots** download.

To run it on your machine, build first. It needs Docker for the sign-in service and reaches no outside host.

```bash
pnpm build
pnpm test:journey
```

On a machine with no Docker, set `AMAN_DEX_DIR` to a folder that holds the `dex` program and its `web` folder.

## Docs website

The docs website is built from the pages in `docs/` and the help topics in `packages/trueforge/guide/topics/`. Those files are the only copy: edit them, never the site. [`docs/README.md`](docs/README.md) is the docs home, and the website's menu follows its sections, so a new page goes in that table too. The website leaves out the parts for people working on the code (the agent harness, measuring changes, and the project pages); `SITE_LEAVES_OUT` in `scripts/build-docs-site.mjs` names them. Their pages are still built, so links to them keep working.

The "Docs site" workflow builds the website on every pull request that touches these pages and publishes it to GitHub Pages when the change reaches `main`. To build it on your own machine, install Python 3, then run:

```bash
pip install -r docs-site/requirements.txt
pnpm docs:site:build
```

The finished site is in `docs-site/site/`. Open `docs-site/site/index.html`, or run `python3 -m http.server -d docs-site/site` and open `http://localhost:8000`.

## Releases

Releases are cut by the maintainer; contributors do not need to do anything release-specific.
