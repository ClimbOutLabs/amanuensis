# Spec: Private by Architecture

**Status:** draft

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

## First slice: "What left your machine"

Built on the approval audit log, not beside it. The audit log answers "what was decided" for tool calls in one chat; it cannot say which host a model request or map lookup reached, or how big it was, so a second table, `outbound_event`, records what was actually sent. It holds the kind, the service host, the model or tool name, the request size and the time, and never request text. An email row also holds the recipient count and a shortened subject.

Settings > "What left your machine" (owner only) shows two things from real records:

- **What Aman keeps, and where:** chats, memory, personas, files from runs, settings and backups, each with the real folder or database from the running configuration and its size when cheap to measure. Backups are made only when the owner runs `aman backup --target <folder>`, so no folder or size is claimed for them.
- **What went out in the last 24 hours:** one row per request, newest first. A long list folds the model requests of one chat into one row. An empty list says "Nothing has left this computer in the last 24 hours."

Rows are written where the request is sent, just before it goes:

| Kind           | Where it is written                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model request  | The model client's fetch, for chat turns, scheduled runs and the helper calls a turn makes (memory summary, profile learning, library relevance). |
| Email sent     | The connector call path, for a send-style email tool that was approved or allowed.                                                                |
| Web search     | The connector call path, for the connector designated as search provider.                                                                         |
| Map lookup     | The shared map upstream fetch: the agent's geocoder and router requests and the tile proxy.                                                       |
| Connector call | The connector call path, for any other remote connector.                                                                                          |

A call that waits for approval or is denied is not recorded, because nothing was sent. A request to this computer itself (loopback) is not recorded. Not covered yet: network use inside the sandbox, git pushes through the git bridge, the first download of the embedding model, sign-in with the identity provider, connector setup checks and OAuth, the optional memory (Hindsight), recall screening and speech-to-text services, and the bug-report handoff.

Rows older than 30 days are deleted daily; the page reads the last 24 hours.

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
