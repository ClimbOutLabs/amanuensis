# Amanuensis documentation

Amanuensis (Aman for short) is a private assistant that runs on your own computer. These guides are grouped by what you want to do. Pick the guide that matches you, then the page that matches your task.

- [Getting started](#getting-started): Install Aman and have your first chat.
- [User guide](#user-guide): Get things done with Aman day to day.
- [Running your instance](#running-your-instance): Look after the install: people, devices, backups, upgrades.
- [Security and privacy](#security-and-privacy): Know what Aman can do on its own and what leaves your computer.
- [Troubleshooting](#troubleshooting): Fix something that is not working.
- [Developer guide](#developer-guide): Build Aman from source, change it, or build on its agent harness.
- [Reference](#reference): Look up the API, SDK and UI kit.
- [Project](#project): See what changed and how this project relates to TrueForge.

## Getting started

- [Try Aman](try-aman.md): What you need, then install and first chat, step by step.
- [Install on a Mac](install-mac.md): Install the latest release on a Mac.
- [Install on Linux](install-linux.md): Install the latest release on Ubuntu or Debian.
- [Install on Windows](install-windows.md): Install with Aman Setup, one download.
- [Installer reference](install.mdx): Everything the installer does and asks: first login, extra instances, other devices.
- [First steps](../packages/trueforge/guide/topics/first-steps.md): What to try in your first few minutes.
- [What Aman is](../packages/trueforge/guide/topics/what-is-aman.md): What Aman does and does not do.
- [Connect a model](models.mdx): Add a model provider or your own endpoint.

## User guide

These are the same pages Aman's **Help, I'm stuck** answers from.

**Everyday tasks**

- [Your morning brief](../packages/trueforge/guide/topics/daily-brief.md): The daily brief and planning your day.
- [Handling your email](../packages/trueforge/guide/topics/email.md): Reading, sorting and replying to mail.
- [Keeping your calendar](../packages/trueforge/guide/topics/calendar.md): Events, invites and changes.
- [Running things on a schedule](../packages/trueforge/guide/topics/schedules.md): Reminders and repeating tasks.
- [Living documents](../packages/trueforge/guide/topics/documents.md): Pages Aman writes and keeps up to date.
- [Spaces](../packages/trueforge/guide/topics/spaces.md): Your saved pages.
- [Searching the web](../packages/trueforge/guide/topics/web.md): Web search and Aman's browser.
- [Doing a step yourself in the live browser](../packages/trueforge/guide/topics/live-browser.md): Signing in or solving a check while Aman waits.
- [Finding places and planning routes](../packages/trueforge/guide/topics/places.md): Maps, travel times, when to leave.
- [Reading files and running code](../packages/trueforge/guide/topics/code.md): Attachments and the code sandbox.
- [Clearing your head](../packages/trueforge/guide/topics/clear-head.md): Breaking tasks into steps.
- [Planning meals](../packages/trueforge/guide/topics/meals.md): Meal plans and shopping lists.
- [Doctor's appointments](../packages/trueforge/guide/topics/doctors-appointments.md): Getting ready for a visit.
- [Finding forgotten subscriptions](../packages/trueforge/guide/topics/subscriptions.md): Spotting what you still pay for.
- [Using Aman from your phone](../packages/trueforge/guide/topics/phone.md): Reaching Aman away from your computer.

**Connecting your accounts**

- [Connecting your email and calendar](../packages/trueforge/guide/topics/connect-mail-calendar.md): Which account type to pick and how.
- [Google](google.mdx): Gmail and Google Calendar, step by step.
- [Connectors (MCP servers)](mcp-servers.mdx): Adding a connector from the catalog or your own URL.
- [Your notes folder](../packages/trueforge/guide/topics/notes-folder.md): Letting Aman search and add to your notes ([setup](connectors/notes-folder.md)).

**Making Aman yours**

- [Memory](../packages/trueforge/guide/topics/memory.md): What Aman remembers and how to change it ([how it works](memory.md)).
- [Personas, agents, and choosing who answers](../packages/trueforge/guide/topics/personas.md): Personas and agents in a chat.
- [Ready-made personalities](personalities/README.md): Five personalities to start from.
- [Roles and personas](model-roles.mdx): Which model does which job.
- [Personalization](personalization.mdx): Aman's name, voice and your preferences.
- [Changing how Aman looks](../packages/trueforge/guide/topics/appearance.md): Theme and appearance.
- [Learning new skills](../packages/trueforge/guide/topics/skills.md): Teaching Aman a new skill ([setup](skills.mdx)).
- [Voice input](voice-input.mdx): Talking to Aman instead of typing.
- [What Aman costs](../packages/trueforge/guide/topics/costs.md): Where the money goes.

## Running your instance

- [The aman command](commands.md): Every command for checking, backing up, updating and repairing Aman.
- [Adding people](install.mdx#adding-people): Giving someone else their own Aman.
- [Using it from other devices](install.mdx#using-it-from-other-devices): Reaching Aman from your phone or laptop.
- [Doctor](install.mdx#doctor): `aman doctor` and what each check means.
- [Backup and upgrade](install.mdx#backup-and-upgrade): Upgrading and the backup commands.
- [Backups](backup.md): How backups work and copying one off your computer.
- [Forgot your password](install.mdx#forgot-your-password): Getting back in.
- [Your sign-in and password](../packages/trueforge/guide/topics/account.md): Changing your password and sign-in.
- [Sign-in](authentication/overview.mdx): How Aman signs people in.
- [Sandbox](sandbox.mdx): Where Aman runs code, and how to set it up.
- [Aman's browser](browser.md): Aman's own browser and the live view.
- [Nemotron on Nebius Token Factory](token-factory.md): Using the Token Factory model provider.
- [Move from the old compose stacks](migrate-from-compose.md): Moving an older install to the installer.

## Security and privacy

- [Safety](safety.md): What Aman does on its own and what waits for your OK.
- [Approval cards and permissions](../packages/trueforge/guide/topics/approvals.md): Reading and answering approval cards.
- [Privacy](privacy.md): What leaves your computer and what stays on it.
- [Where your data lives](../packages/trueforge/guide/topics/privacy.md): Your data, in plain words.
- [Schedules](schedules.md): How a scheduled run holds actions for you.
- [Deployment security](deployment-security.mdx): What the defaults protect, and what to change before opening Aman up.
- [Reporting a security problem](../SECURITY.md): How to tell us privately.

## Troubleshooting

- [Troubleshooting](troubleshooting.md): Common problems, what they mean and the one thing to do.
- [Install troubleshooting](install.mdx#troubleshooting): Docker group, ports in use, credentials, clock, sign-in.
- [Doctor](install.mdx#doctor): Running `aman doctor` and following its fixes.
- [Getting help and reporting a bug](../packages/trueforge/guide/topics/getting-help.md): Asking Aman for help and telling us about a bug.
- [Report a problem on GitHub](https://github.com/ClimbOutLabs/amanuensis/issues): Open an issue.

## Developer guide

**Run from source**

- [Quickstart from source](quickstart.mdx): Run Aman from a fresh clone and build your first agent.
- [Contributing](../CONTRIBUTING.md): How to send a change.
- [Releasing](../RELEASING.md): How a release is made.

**The agent harness (TrueForge)**

- [Introduction and architecture](introduction.mdx): What the harness is and how it fits together.
- [Initial setup](harness/initial-setup.mdx): Models, connectors, skills and sandbox, set once.
- [Create an agent](create-agent/overview.mdx): Every option on an agent.
- [Agents](agent-library.mdx): Browsing and editing saved agents.
- [Harness capabilities](key-features/overview.mdx): Sandbox as a tool, context handling, checkpoints.
- [Subagents](key-features/subagents.mdx): Handing subtasks to parallel subagents.
- [Deferred tool loading](key-features/deferred-tool-loading.mdx): Loading tool definitions on demand.
- [Code mode](key-features/code-mode.mdx): One script in the sandbox to chain tool calls.
- [Large tool responses](key-features/large-tool-responses.mdx): Moving big tool output into the sandbox.
- [Skills setup](skills.mdx): Registering skill packs from git.
- [Chat UI](chat-ui.mdx): The bundled chat and the React UI kit.

**Measuring changes**

- [Benchmarking](benchmarking.mdx): How the harness compares, and how to rerun it.
- [Token eval](evals/token-eval.md): Token and step use on a fixed prompt set.
- [Space eval](evals/space-eval.md): How reliably Aman builds spaces.
- [Memory design](../ops/memory/DESIGN.md) and [runbook](../ops/memory/RUNBOOK.md): How memory is stored and looked after.

## Reference

- [HTTP API (OpenAPI)](openapi.json): Every server route.
- [SDK quickstart](api/quickstart.mdx): Stream your first agent turn.
- [SDK concepts](api/overview.mdx): Agent, session, turn, event and delta.
- [Use an agent](api/use-agent.mdx): Recipes for streaming, approvals, questions and reconnects.
- [UI kit](ui-sdk/README.md): Quickstart, guides and reference for the React UI kit.

## Project

- [Changelog](CHANGELOG.md): What changed in each release.
- [Roadmap](roadmap.mdx): Planned harness work.
- [Attribution](AMANUENSIS_ATTRIBUTION.md): What Amanuensis adds to TrueForge.
- [Upstream sync](UPSTREAM_SYNC.md) and [divergence policy](../DIVERGENCE.md): How this fork takes in TrueForge changes.
