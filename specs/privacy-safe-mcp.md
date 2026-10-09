# Spec: Privacy-Safe MCP Integrations

## Problem

Aman has a Gmail MCP, but every new integration (calendar, to-dos, notes) is a new place where secrets can leak and permissions can be over-broad. There is no consistent pattern for adding integrations safely.

## Solution

A standard integration framework for MCP servers with three guarantees: secrets are masked everywhere, permissions are scoped per integration, and each integration can be independently enabled, audited, and revoked.

## Design Decisions

**Masked secrets.** OAuth tokens, API keys, and credentials are stored server-side and never rendered in the UI, logs, or error messages. The UI shows only "connected" status and scope list, never the secret value.

**Per-integration permission scopes.** Each integration declares the minimum scopes it needs (e.g. calendar.read, not full account access). The user grants scopes at connect time and can narrow them later. The agent cannot call tools outside the granted scopes.

**Independent lifecycle.** Each integration has its own connect/disconnect, health check, and audit log. Disconnecting revokes tokens and stops all access immediately.

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

## Out of Scope

- The calendar integrations themselves (see calendar-mcp-integrations spec)
- Fine-grained per-folder or per-label scopes (v1 is per-integration)
