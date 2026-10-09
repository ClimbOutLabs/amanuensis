# Spec: Private by Architecture

## Problem

"Private" is currently a claim, not a product surface. Users cannot see what data Aman holds, where it flows, or prove that nothing leaks. Privacy needs to be visible, verifiable, and toggleable.

## Solution

Make privacy a first-class product area: an offline-mode toggle, a zero-telemetry dashboard, encrypted per-persona vaults, full data export, and human-readable data-flow documentation.

## Design Decisions

**Offline-mode toggle.** One switch that cuts all network access except the model endpoint (which is local on the Spark anyway). When on, Aman works fully offline: memory, personas, and local tools keep working. Cloud-backed MCP integrations pause with a clear notice.

**Zero-telemetry dashboard.** A screen that shows, in plain language: what data Aman stores, where it lives on disk, what (if anything) was sent over the network in the last 24 hours, and to where. Empty by default, and the goal is to keep it empty.

**Encrypted per-persona vaults.** Each persona's memory, knowledge library, and settings are encrypted at rest with a per-persona key. Unlocking a persona requires the key (derived from the user's passphrase).

**Full export.** One button exports everything Aman knows: all personas, memories, knowledge libraries, settings, and task definitions. Standard formats (JSON + Markdown). This is the exit door: the user owns their data.

**Data-flow docs.** Every feature that touches the network documents its data flow: what is sent, to which endpoint, and why. Linked from the dashboard.

## Scope

- Offline-mode toggle in Settings with clear behavior description
- Telemetry dashboard: stored data inventory, 24h network activity log
- Per-persona encryption at rest
- Full export (JSON + Markdown)
- Data-flow documentation per network-touching feature

## Privacy

- This spec is the privacy product. Every decision above serves it directly.

## Testing

- Verify: offline toggle blocks all external requests (packet capture)
- Verify: dashboard correctly reports an empty network log after a local-only session
- Verify: encrypted vault is unreadable without the key (inspect on disk)
- Verify: export contains all personas and re-imports cleanly
- Verify: data-flow docs exist for every MCP integration

## Out of Scope

- End-to-end encrypted sync across devices (future)
- Plausible-deniability or hidden vaults
- Third-party security audit (recommended before public launch, not part of this spec)
