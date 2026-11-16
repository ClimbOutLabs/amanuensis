# Spec: Privacy-Safe MCP Integrations

**Status:** draft

## Problem

Aman has a Gmail MCP, but every new integration (calendar, to-dos, notes) is a new place where secrets can leak and permissions can be over-broad. There is no consistent pattern for adding integrations safely.

## Solution

A standard integration framework for MCP servers with three guarantees: secrets are masked everywhere, permissions are scoped per integration, and each integration can be independently enabled, audited, and revoked.

## Design Decisions

**Masked secrets.** OAuth tokens, API keys, and credentials are stored server-side and never rendered in the UI, logs, or error messages. The UI shows only "connected" status and scope list, never the secret value.

**Per-integration permission scopes.** Each integration declares the minimum scopes it needs (e.g. calendar.read, not full account access). The user grants scopes at connect time and can narrow them later. The agent cannot call tools outside the granted scopes.

**Independent lifecycle.** Each integration has its own connect/disconnect, health check, and audit log. Disconnecting revokes tokens and stops all access immediately.

**Tool hints never lower a user-added connector's tier.** A user-added connector's own MCP annotations (`readOnlyHint`, `openWorldHint`, `destructiveHint`) can only make a call ask, never skip asking, so every tool on a user-added connector asks on first use. An absent `openWorldHint` counts as open-world, as the MCP spec defines it.

**First-party connectors (provisional).** A connector is first-party only when the host itself set it up. The mark lives on the server's connector record, and every create or update request stores it as off, so nothing in Settings, the API or a chat can set it. A connector added by URL is never first-party, whatever its tools declare. A first-party connection never follows a redirect: an answer with any 3xx status is refused as an error that names the origin it pointed at, so a first-party origin cannot hand its mark to another host. Gmail is mounted by the server itself, so its mark is set where it is mounted. On a first-party connector a tool that declares `readOnlyHint: true` and an explicit `openWorldHint: false` runs without asking, so it needs no grant, and every run is recorded in the Sentinel audit log. Every escalation still wins: destructive hints, destructive or install names, sensitive reads, external-service actions, offline auto-deny, and an explicit require-approval selector. A tool that omits `openWorldHint` asks, as on any connector. The other first-party connectors are the app's own Email and Calendar sidecars. They are first-party only at the exact address the host was set up with for that sidecar, whose origin the host works out from its own setup; a stored mark neither grants nor removes that, and a host with no such address has none. An import leaves out an Email or Calendar connector at any other address and says so, nothing from an import is first-party, and nothing is trusted by the name. Their reads run without asking; a mail send or a calendar change always asks, and Always allow everywhere never covers a send. This decision is revisited on 2026-10-15.

**Always allow everywhere.** On first use the approval offers Allow (this one call only), Always allow in this chat, Always allow everywhere (remember it for every chat), and Deny. There is no Always deny. Always allow everywhere is offered only for a tool that declares itself read-only and explicitly closed-world, and stores a grant for that user, connector, and tool, never wider. It is honored only while the tool still declares itself that way, and destructive hints, destructive or install names, sensitive reads, external-service actions, offline auto-deny, and an explicit require-approval selector all still ask or deny. Every call a grant runs is recorded in the Sentinel audit log. The connector's page in Settings lists the user's grants with Revoke; deleting a connector or changing its URL removes every user's grants for it.

**Consistent UX.** All integrations live in Settings → Integrations with the same card layout: name, status, scopes granted, last sync, disconnect button.

## Scope

- Integration framework: secret storage, scope enforcement, audit logging
- Reference integrations: calendar (see calendar-mcp-integrations spec), email (Gmail MCP migrated to the framework), to-dos, notes
- Settings UI: integration cards with scope display and revoke
- Audit log: which integration accessed what, when

## Privacy

- This spec IS the privacy story for integrations: masked secrets, minimal scopes, full auditability
- Data-flow documentation per integration (what data flows where)

## Testing

- Synthetic accounts only, never the user's real credentials
- Verify: connecting shows only the requested scopes
- Verify: secret values never appear in UI, logs, or API responses
- Verify: revoking access immediately stops the agent from using the integration
- Verify: audit log records every access
- Verify: a read-only connector tool asks on first use; Always allow everywhere skips the ask for that user, connector, and tool only, and Revoke restores it
- Verify: on a first-party connector a tool that declares read-only and closed-world runs without asking and is audited, while the same tool without an explicit closed-world hint, a write tool, and the same tool on a user-added connector all ask
- Verify: no create or update request can mark a connector first-party, and a connector at a lookalike of the host's Email or Calendar address stays user-added and asks
- Verify: a first-party origin that answers a connection with a redirect is refused and the redirect target is never contacted

## Out of Scope

- The calendar integrations themselves (see calendar-mcp-integrations spec)
- Fine-grained per-folder or per-label scopes (v1 is per-integration)
