# Amanuensis attribution

Amanuensis is the user-facing product built from the TrueForge open-source
agent harness. Amanuensis is licensed under the Mozilla Public License 2.0;
see the LICENSE file at the repository root. The original TrueForge and
TrueFoundry attribution, copyright notices, and the MIT license for the
upstream portions remain in the NOTICE file at the repository root and in
the package notices.

The Amanuensis name and visual treatment are a product rebrand only. Internal
package names and upstream dependency names remain unchanged so their licenses,
source lineage, and upgrade paths stay clear.

## What we built vs what came from upstream

The fork was cut from upstream TrueForge on 24 August 2026. The public history starts on 26 September 2026 with an import of earlier fork work, flattened into one commit.

From upstream TrueForge:

- the agent runtime, tool calling, the approvals framework, sessions and context compaction triggers;
- the HTTP server, sign-in, SQLite and Postgres storage, model providers and the schedule runner;
- MCP connector support, the model catalog, the UI toolkit, the generated SDK, the Helm chart and the harness docs.

From other open-source projects, used as they are:

- a Gmail MCP server under `mcp/gmail` (MIT licence, credited in its own license file);
- small open models for speech-to-text, memory search and prompt-injection screening.

Built in this fork in a private repo, from 24 August to 26 September 2026 (imported on 26 and 27 September):

- long-term memory as local Markdown files, personas, persona knowledge and profile learning;
- Memory Vault sharing, export and import, Spaces, session metrics and bug reports;
- the Gmail connector, theme presets, UI polish, model catalog presets and compaction reliability work;
- the first code-running sandbox, the private-data scanner and the feature specs.

Built in this fork in the public repo, from 27 September 2026:

- the Nebius Token Factory provider with Nemotron defaults, helper jobs on a smaller Nemotron model, a daily token cap and a per-answer model and cost line;
- the guided installer with sign-in, local HTTPS, daily backups, a doctor command and upgrades;
- tiered approvals with cards, an audit log, durable approval tokens and "Always allow" grants;
- scheduled runs that hold actions for the owner instead of doing them;
- outbound guards, sealed sandbox slots, local voice input, embedded maps, per-persona memory vaults, and data export and import.
