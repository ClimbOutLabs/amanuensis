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

**Tool hints never lower a connector's tier.** A user-added connector's own MCP annotations (`readOnlyHint`, `openWorldHint`, `destructiveHint`) can only make a call ask, never skip asking, so every tool on a user-added connector asks on first use. An absent `openWorldHint` counts as open-world, as the MCP spec defines it.

**Always allow this tool.** On first use the approval offers Allow once, Allow in this chat, Always allow this tool, and Deny. Always allow is offered only for a tool that declares itself read-only and explicitly closed-world, and stores a grant for that user, connector, and tool, never wider. It is honored only while the tool still declares itself that way, and destructive hints, destructive or install names, sensitive reads, external-service actions, offline auto-deny, and an explicit require-approval selector all still ask or deny. Every call a grant runs is recorded in the Sentinel audit log. The connector's page in Settings lists the user's grants with Revoke; deleting a connector or changing its URL removes every user's grants for it.

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
- Verify: a read-only connector tool asks on first use; Always allow skips the ask for that user, connector, and tool only, and Revoke restores it

## Out of Scope

- The calendar integrations themselves (see calendar-mcp-integrations spec)
- Fine-grained per-folder or per-label scopes (v1 is per-integration)
