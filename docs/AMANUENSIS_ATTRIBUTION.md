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

Aman was forked from TrueForge on 24 August 2026 and has been built since in two GitHub repositories, both by ClimbOutLabs:

1. **A private repository**, from 24 August to 27 September 2026. It stays private because it holds planning notes and personal details. Its code was brought into this repository on 26 and 27 September 2026.
2. **This repository**, from 26 September 2026 to now. It was created on GitHub on 14 September 2026 (15 September in UTC). Its first commit of our own is the import of 26 September.

### At a glance

|                               | Private repository | This repository  | Together         |
| ----------------------------- | ------------------ | ---------------- | ---------------- |
| Pull requests merged          | 300                | 506              | 806              |
| Our own work among them       | 291                | 505              | 796              |
| Upstream syncs or ports       | 4                  | 1                | 5                |
| Dependency updates            | 5                  | 0                | 5                |
| Dates of merged pull requests | 26 Aug to 27 Sep   | 27 Sep to 30 Oct | 26 Aug to 30 Oct |

In mid-October about 20 pull requests in this repository were landed a second time after review, under new numbers, so the count of distinct changes here is a little lower than 506.

Code measured with git:

- **Private-repository work:** about 352,000 lines added to TrueForge, from the fork commit `d421135d` to the imported private main `948734594`.
- **This repository since the import** (commit `2440bfb2a`, 3,557 files): 2,775 commits, 2,354 files added, 1,060 imported files changed, about 452,000 lines added (about 394,000 without generated files), and test files up from 820 to 1,769.
- **Since the fork, all together:** 4,262 files added and 781 TrueForge files changed. Only 847 of TrueForge's 1,720 files are untouched. About 783,000 lines were added and 27,000 removed.

### From upstream TrueForge

- the agent runtime, tool calling, the approvals framework, sessions and context compaction triggers;
- the HTTP server, sign-in, SQLite and Postgres storage, model providers and the schedule runner;
- MCP connector support, the model catalog, the UI toolkit, the generated SDK, the Helm chart and the harness docs.

After the fork, upstream work came in only through one merge of upstream main in the private repository (with its sync tooling and a test fix), and through one pull request here, #138 on 16 October 2026. That pull request ported fixes from six later TrueForge pull requests (701, 775, 828, 843, 981 and 999).

### From other open-source projects, used as they are

- a Gmail MCP server under `mcp/gmail` (MIT licence, credited in its own license file);
- small open models for speech-to-text, memory search and prompt-injection screening.

### Built in the private repository (24 August to 27 September 2026)

About 291 merged pull requests of our own, in these areas:

- **Memory (37).** Long-term memory enforced by the host, moved from an outside memory server to local Markdown files with embedding search. A learned profile of the person, a recall screen, a memory switch per chat, relevance gates and a Memory section in Settings.
- **Personas and skills (15).** Switching personas by name, separate context per persona, and a persona knowledge library with sources. Skills gained prerequisites and reliable delivery.
- **Spaces (16).** Pages the assistant writes and keeps up to date, including HTML pages with a designed stylesheet, sanitising, revision history with revert, and edits in small pieces.
- **Sandbox and coding (28).** Supervised code runs with host checks, structured file edits with patch support, honest results, files kept on the host, and OCR and audio tools in the sandbox.
- **Documents (10).** Local PDF reading and OCR, attachments read at upload with progress, and Word reports with evidence, held for approval.
- **Model roles and providers (15).** A model per job, saved roles, provider and skill management, and fixes for self-hosted models.
- **Connectors (11).** Connector health, OAuth fixes, web search and fetch display, and a Gmail MCP server with bounded results.
- **Reliability (28).** Context compaction fixes, loop and repeat guards, phase budgets, recovery from broken streams and orphaned tool calls, and reconnecting.
- **Privacy and security (12).** Screening of outside content and recalled memory, prompt-injection screening on a GPU, no unauthenticated network listeners, and HTML sanitising.
- **Look and feel (58).** The warm paper-and-brass look, light and dark themes, the animated mascot, the readable chat column, mobile fixes, LaTeX and citation links.
- **Chief of staff (8).** Commitments tracked from chat and shown on Home.
- **Bug reports (6).** A redacted diagnostic bundle from the sidebar.
- **Install docs, the public export pipeline, CI and migrations (51).**

### Built in this repository (26 September to 30 October 2026)

About 505 merged pull requests of our own. Pull request numbers below are in this repository.

- **Nebius Token Factory and Nemotron.** Token Factory as a provider with Nemotron defaults, a picker for Super, Ultra and Nano, a daily token cap, the model and cost shown on every answer, and fixes for leaked tool-call tags, early "done" claims and runaway text (#48, #211, #562, #568, #591).
- **Prompt size and cost.** A smaller prompt per turn, tools sent in a stable, cacheable order, limits on tool results, and a usage summary (#327, #378, #380, #383, #417).
- **Approvals and permissions.** Tiered approvals with an audit log; Approve, for this chat, Always allow and Deny; approvals that survive restarts and stay bound to what the owner saw. Cards say plainly what leaves the computer, and scheduled runs hold actions for the owner (#65, #202, #207, #223, #321, #412, #440, #446, #448).
- **Email.** A mail connector for Gmail and any IMAP mailbox: read, draft and reply with approval, attachments read in the sandbox, tracking pixels dropped and pictures held back (#216, #309, #358, #429).
- **Calendar.** Google and CalDAV calendars, with reading, accepting, declining and changing events after approval. Changes that reach guests always ask (#236, #326, #372, #505).
- **Security and privacy guards.** Untrusted content cannot pose as the person or become trusted memory. Secrets are kept out of logs, errors and cards. Searches hold private details for approval. Remote pictures no longer load by themselves. Sign-in and every route check the owner (#203, #204, #214, #215, #217, #341, #414, #457).
- **Sandbox and repo work.** A Docker sandbox with sealed slots, support for Docker Desktop on Mac, download-only package mirrors, linters and test runners, and "work on a repo" (#291, #304, #314, #332).
- **Installer.** A guided installer with sign-in, local HTTPS, backups, home-network and phone access, `aman doctor`, upgrades, a signed release manifest, and a Windows setup program (#128, #418, #438, #520, #531, #556, #573).
- **Memory.** Per-persona memory vaults, a Memories explorer, saving only real facts the person said, recall that puts named people first and keeps the assistant's own advice (#94, #142, #368, #481, #570, #595).
- **Personas, onboarding and tour.** Aman as a chief of staff with specialists, a create-persona tool, a built-in guide, a first-screen tour, and switching between personas from inside one (#310, #316, #317, #318, #606).
- **Spaces.** One plain tool contract, no approval cards for writes, and reliable large writes (#450, #485, #492, #552).
- **Maps and web search.** Embedded maps with walking, cycling and transit routes, a grounded place finder, and Tavily search (#122, #351, #364, #601).
- **Morning brief and schedules.** Schedules made from chat, runs that hold actions, one-time reminders, and the morning brief (#263, #267, #360, #456, #468).
- **Voice.** On-device speech-to-text in the composer (#47, #57).
- **Export and import.** Moving a person's data between instances safely, with older formats upgraded (#210, #238, #266).
- **Reliability.** Stuck turns end by themselves, cancel always works, dropped streams resync, and a turn never ends silently (#107, #371, #401, #424, #599).
- **Look and feel.** Four themes, the ticket-and-receipt look and a calmer home page (#333, #338, #445).
- **Demo world.** Maya, an invented person in Lisbon, with mail, a calendar, memories and a nightly reset (#462, #540, #560, #608).

### How to check

These run in this repository:

```
git diff --shortstat d421135d 948734594        # private-repository work, as imported
git diff --shortstat 2440bfb2a origin/main     # this repository since the import
git rev-list --count 2440bfb2a..origin/main
git log --merges --oneline 2440bfb2a..origin/main | grep -c 'Merge pull request'
```

The private repository's pull request counts come from its own pull request list, which is private.
