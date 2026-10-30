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
- email and calendar connectors for any IMAP mailbox, Gmail, CalDAV and Google calendars, which draft but never send or change anything without approval;
- the morning brief, web search with private-data guards, and memory that keeps only what the person said and puts notes about named people first;
- the Maya demo world with a nightly reset.

## How much changed in the public repo

The baseline is the public repo right after the import, commit `2440bfb2a` on 27 September 2026. It held 3,557 files. The figures below cover everything after it, through 30 October 2026.

| Measure                                   | Since the import                                      |
| ----------------------------------------- | ----------------------------------------------------- |
| Commits                                   | 2,775 (1,728 not counting merges)                     |
| Pull requests merged                      | 404                                                   |
| Files added                               | 2,354                                                 |
| Imported files changed                    | 1,060                                                 |
| Imported files removed                    | 16                                                    |
| Imported files still exactly as they were | 2,481 of 3,557                                        |
| Lines added                               | about 452,000 (about 394,000 without generated files) |
| Lines removed                             | about 39,000                                          |
| Test files                                | 820 at the import, 1,769 now                          |

For scale, the private-repo work added about 352,000 lines to TrueForge. The public repo has added more than that since.

Parts that did not exist at the import, with commits and lines added:

| Part                                        | Commits | Lines added  |
| ------------------------------------------- | ------- | ------------ |
| Installer and `aman doctor`                 | 182     | about 47,000 |
| Approvals and permissions for personal data | 242     | about 11,000 |
| Email connector                             | 65      | about 4,700  |
| Calendar connector                          | 28      | about 2,100  |
| Export and import                           | 72      | about 6,700  |
| Sandbox slots                               | 26      | about 2,700  |
| Maps and travel                             | 15      | about 1,100  |
| Web search                                  | 17      | about 1,600  |
| Demo world                                  | 50      | about 7,600  |

Parts that existed at the import and changed substantially:

| Part                 | Commits | Lines added  |
| -------------------- | ------- | ------------ |
| Chat UI              | 520     | about 69,000 |
| Agent loop           | 176     | about 5,300  |
| Code-running sandbox | 128     | about 8,000  |
| Memory               | 65      | about 3,900  |

On 16 October 2026, fixes from six later TrueForge pull requests were ported in (upstream PRs 701, 775, 828, 843, 981 and 999). They show in the history as merges named `upstream/pr-…`, and they are the only outside code added after the import.

To check these figures:

```
git diff --shortstat 2440bfb2a origin/main
git rev-list --count 2440bfb2a..origin/main
git diff --shortstat d421135d 948734594
```

The last command measures the private-repo work: TrueForge at the fork, compared with the private main branch as it arrived.
