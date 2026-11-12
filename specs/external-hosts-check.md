# Spec: Prove which outside hosts Aman contacts

**Status:** approved

## Problem

Aman says the browser loads nothing from third parties and the server talks only to the services a person sets up. Nothing checked that. Upstream leftovers broke it: the code-snippet panel showed an icon from TrueFoundry's CDN, the model and MCP catalogs named logos on that CDN (the server fetched them), the agent page linked upstream's docs site, the API docs page loaded Swagger UI from a CDN, and the UI kit could load Google Fonts.

## Solution

1. Remove the leftovers. Logos and the TypeScript mark ship with the UI kit. The API docs page serves Swagger UI from the server. The Google Fonts loader is gone. The View Docs link points at `docs/api/use-agent.mdx`.
2. A static check, `scripts/check-external-hosts.mjs` (`pnpm run test:external-hosts`), runs in CI on every PR. It reads every `http(s)`/`ws(s)` host, protocol-relative loads, and bare hosts handed to a connection from the shipped source, and checks each against `scripts/external-hosts.allowlist.json`.
3. A runtime mode, `--runtime`, checks the hosts recorded while the app ran: Playwright's request log for the browser, and `scripts/record-outbound-hosts.mjs` (a Node `--import` hook on name lookups and `net`/`tls` connects) for the server.
4. README and the privacy page say what the browser and server contact and link the list.

## Design decisions

- **Scanned:** `packages/frontend/{src,index.html,public}`, `packages/trueforge-ui/src`, `packages/trueforge/{src,catalog}`, `packages/trueforge-core/src`, `packages/amanuensis/src`, `packages/aman-installer/src`, `installer/`, `ops/`, and the shipped Dockerfiles. Tests, docs, `demo/` and lockfiles never ship and are not scanned. The Aman guide's knowledge pack is shipped, so it is scanned even though it is built from docs.
- **Not outside hosts:** loopback, Docker service names, reserved test names (`.invalid`, `.example`, `example.com`, ...) and private addresses. They never leave the machine or the private network.
- **The list:** each entry has a host, a category and a one-line reason. Categories and whether they are link-only live in the file. `docs_link`, `setup_guide` and `identifier` are link-only: such a host may be named, but loading it (fetch, `src=`, `<link>`, `<script>`, CSS `url()`, `curl`, ...) fails.
- **Forbidden hosts** fail anywhere, by name, with the reason from the file: Google Fonts, the upstream project's hosts, and common telemetry hosts. A forbidden domain covers its subdomains unless the list allows that exact subdomain (the PostHog MCP server a person may connect).
- **Unused entries fail**, so the list stays the real list.
- **Never auto-adds.** Every failure says the file, the line, the host, and the one thing to do.

## Privacy

The check reads source code only. The runtime mode reads logs from a test run with a fake model and synthetic data. No personal data is involved.

## Testing

`tests/external-hosts-scan.test.mjs` (`pnpm run test:external-hosts-scanner`) builds synthetic fixture repositories: an allowed fetch, an allowed link, a link-only host that is fetched, the removed upstream URLs as the forbidden case, a host missing from the list, excluded paths, the runtime check, the outbound recorder, and the real repository passing its own scan.

## Out of scope

- Blocking outbound traffic at runtime (the sandbox already does this for sandboxed code).
- Auditing dependencies' own network behaviour; the runtime mode catches that once the nightly end-to-end suite runs it.
