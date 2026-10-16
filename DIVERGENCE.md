# Divergence ledger

Every upstream (truefoundry/trueforge) file this fork deliberately changes,
why, and which side wins when an upstream sync conflicts. Consult this file
during every sync; update it in the same PR as any new deliberate change to
an upstream-owned file. Files not listed here default to upstream-wins.

Fork ancestry: the private repo was cut from upstream commit `d421135d`
("feat(catalog): add GLM-5.3 to the z.ai model provider", 2026-08-24) and
flattened into root commit `c198d1be`. A marker merge records that ancestry
so incremental merges work; see docs/UPSTREAM_SYNC.md.

Resolution vocabulary:

- **regenerate**: never hand-merge; take ours during the merge, then rebuild
  from source (SDK, OpenAPI, lockfile) so the artifact reflects the merged
  code.
- **ours**: our version is authoritative; port upstream changes into it by
  hand only when they matter.
- **merge**: genuinely combine both sides by hand.
- **decide**: architectural overlap; needs a human/agent decision before
  resolving (do not pick a side in the editor).

## Generated artifacts (resolution: regenerate)

| Path                              | Note                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| .github/fern/openapi/openapi.json | Output of `pnpm openapi:write`                                           |
| docs/openapi.json                 | Same                                                                     |
| packages/trueforge-sdk/**         | Fern-generated; `pnpm sdk:generate` on Linux (see docs/UPSTREAM_SYNC.md) |
| pnpm-lock.yaml                    | `pnpm install` after the merge resolves manifests                        |

## Infrastructure (resolution: ours)

| Path                                          | Why                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .github/workflows/ci.yml                      | Runs on the aman-wsl self-hosted runner, not hosted runners                                                                                                                                              |
| .github/workflows/pr-agent.yml (ours only)    | Local PR review via a self-hosted PR-Agent                                                                                                                                                               |
| docker-compose.yml                            | `server` service adds `extra_hosts: host.docker.internal:host-gateway` so a host-run custom model provider (e.g. Ollama) is reachable from the container on Linux Docker Engine, not just Docker Desktop |
| scripts/generate-sdk.sh                       | Hardened backup/restore + version pinning around Fern                                                                                                                                                    |
| scripts/check-no-private-data.mjs (ours only) | Private-data scan                                                                                                                                                                                        |

## Memory subsystem (resolution: ours)

Additive modules (no upstream counterpart): packages/trueforge/src/runtime/
memory/**, packages/trueforge/src/runtime/MemoryTurnResourceResolver.ts,
packages/trueforge/src/schemas/memoryEvents.ts, and their tests.

Shared files carrying memory wiring:

| Path                                                        | What we added                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| packages/trueforge/src/apis/turns.ts                        | Provider resolution, capability attach, retain drain hook, multi-message retention |
| packages/trueforge/src/schemas/events.ts                    | MemoryRecallPersistedEvent in list and streaming unions                            |
| packages/trueforge/src/schemas/mcpServer.ts                 | memory_provider manifest flag                                                      |
| packages/trueforge/src/schemas/turn.ts                      | Widened list-events response                                                       |
| packages/trueforge/src/config.ts                            | MEMORY_* settings, FIRST_PARTY_MCP_ORIGINS                                         |
| packages/trueforge/src/apis/mcpServers.ts                   | Single-provider 409, connector delete + OAuth purge, first-party mark              |
| packages/trueforge/src/routes/mcpServerRoutes.ts            | Delete route, 409 declarations                                                     |
| packages/trueforge/src/db/mcpServerStore.ts + both backends | deleteServer, first_party column                                                   |
| packages/trueforge-core/src/core/runtime/AgentThread.ts     | Ambient current-date section with midnight refresh                                 |
| packages/trueforge-ui/...connectorCatalog.ts                | Bearer prefix, memoryProvider mapping, deleteConnector                             |
| packages/trueforge-ui/...ConnectorSettings.tsx              | Memory toggle, Delete control                                                      |
| packages/trueforge-ui/...chatServer.ts                      | Memory event filtered from runtime mappings                                        |

`oauth_client` MCP auth (fork-only, alongside upstream's `dcr`): after this sync, upstream's `McpServerWithAuthStore` (PR #549's store-owns-DCR refactor) owns the whole `authorize()`/`resolveInvokeHeaders()` flow for both `dcr` and `oauth_client`, extended `packages/trueforge/src/db/McpServerWithAuthStore.ts` to pass `authType`/`oauthClientId`/`oauthClientSecret` through to `resolveMcpAuth` when the manifest's auth type is `oauth_client`, using the manifest's own `client_id`/`client_secret` (no registration step, same as `resolveMcpAuth`'s existing `oauth_client` branch in `mcpDcr.ts`). Deleted the handler-side duplicate authorize logic in `packages/trueforge/src/apis/mcpServers.ts`'s `authorizeHandler`; it now just calls `deps.resolveMcpServerStore(c).authorize(...)`, same as upstream's pattern, so the logic has one owner.

`packages/trueforge/src/apis/mcpServers.ts` also had two memory-provider helpers (`findOtherMemoryProviderServer`, `checkMemoryProvider`, and the `memoryProviderWriteRejection` wrapper) hard-coded to the single-tenant `TENANT_ID` constant instead of threading the request context's `tenant_id` like the surrounding handlers. Added a `tenant_id` parameter to all three and passed `requestContext.tenant_id` from every call site (create/put/memory-check handlers).

Memory-provider exclusion on the new upstream "available servers" surface: `packages/trueforge/src/routes/mcpServerRoutes.ts`'s `listAvailableMcpServersRoute`/`getAvailableMcpServerRoute` and their handlers in `mcpServers.ts` list connectors a chat can attach; the memory-provider row is host-managed (see the section above) and is excluded from these lists the same way it is excluded from the chat connector picker, so a user cannot attach it as an ordinary tool server.

## First-party connector trust, Always allow, redirect refusal (resolution: ours)

Sentinel (`packages/trueforge-core/src/core/permissions/**`), `core/mcp/approvalGrant.ts`,
`packages/trueforge/src/mcp/firstParty.ts`, the `mcp_tool_grant` store with both backends and its migrations,
`packages/trueforge-ui/src/server/connectorToolGrants.ts`, and their tests have no upstream counterpart, so
nothing there can conflict. The upstream-owned files below call into them; keep ours in each. The
`FIRST_PARTY_MCP_ORIGINS` setting in `config.ts` and the `first_party` column in `db/mcpServerStore.ts` with both
store backends are listed under Memory subsystem above.

| Path                                                                                                | What we added                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/trueforge-core/src/core/mcp/ToolSet.ts                                                     | Sentinel hook: classifies each call with the host's `firstParty` flag, audits standing-trust runs; a selector only adds a gate                          |
| packages/trueforge-core/src/core/mcp/remoteMcpClient.ts                                             | `refuseRedirects`: a first-party connection sends redirect mode `manual` and fails on any 3xx                                                           |
| packages/trueforge-core/src/core/mcp/RemoteMCP.ts                                                   | Passes `refuseRedirects` through to `connectRemoteMcp`                                                                                                  |
| packages/trueforge-core/src/agent-session/TurnResourceResolver.ts                                   | Takes `first_party` per connector from the host's `mcp` lookup; first-party connectors refuse redirects                                                 |
| packages/trueforge-core/src/core/runtime/AgentThread.ts                                             | `always` approval scope is validated and recorded as a tool grant, Sentinel context only (current-date row is above)                                    |
| packages/trueforge-core/src/core/events/schema.ts                                                   | `always` in the approval allow scope and in its admission provenance                                                                                    |
| packages/trueforge-core/src/core/index.ts                                                           | Re-exports Sentinel (`permissions/*`) including the tool grant types, and the redirect helpers                                                          |
| packages/trueforge-core/src/core/capabilities/builtins/CurrentDateTime.ts                           | Read-only built-in declares `openWorldHint: false`, because an absent hint now counts as open-world                                                     |
| packages/trueforge-core/src/core/capabilities/builtins/OpenUI.ts                                    | Same: explicit `openWorldHint: false` on the read-only instructions tool                                                                                |
| packages/trueforge-core/src/core/runtime/DeferredTool.ts                                            | Same: explicit `openWorldHint: false` on its three read-only tools                                                                                      |
| packages/trueforge-ui/src/containers/SettingsBuilder/ConnectorDetails.tsx                           | Lists the user's always-allowed tools with Revoke                                                                                                       |
| packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/catalogs/connectorCatalog.ts       | `listToolGrants` and `revokeToolGrant` over the `tool-grants` routes, called directly until the SDK is regenerated                                      |
| packages/trueforge-ui/test/containers/SettingsBuilder/ConnectorDetails.test.tsx                     | Covers the always-allowed list and Revoke                                                                                                               |
| packages/trueforge-ui/test/plugins/trueforge-agent-server-adapter/catalogs/connectorCatalog.test.ts | Covers the grants calls                                                                                                                                 |
| packages/trueforge/src/apis/mcpServers.ts                                                           | Tool-grant list and revoke; grants dropped on URL change and delete; first-party mark from the origin list; first-party tools listing refuses redirects |
| packages/trueforge/src/routes/mcpServerRoutes.ts                                                    | `GET /{name}/tool-grants` and `DELETE /{name}/tool-grants/{tool_name}`                                                                                  |
| packages/trueforge/src/schemas/mcpServer.ts                                                         | `McpToolGrant` schema, its params, and the list and delete responses                                                                                    |
| packages/trueforge/src/apis/settings.ts                                                             | Passes `toolGrantStore` to the MCP servers router                                                                                                       |
| packages/trueforge/src/apis/turns.ts                                                                | Hands the connector's `first_party` from `getMcpConnection` to the resolver                                                                             |
| packages/trueforge/src/runtime/sessionResources.ts                                                  | `getMcpConnection` reports `first_party`: the stored mark, only while its origin is still listed                                                        |
| packages/trueforge/src/app.ts                                                                       | `mcpToolGrantStore` dep, passed to the settings and MCP servers routers                                                                                 |
| packages/trueforge/src/main.ts                                                                      | Builds the grant store (SQLite or Postgres) and gives it to `createSentinelServices` and the app                                                        |
| packages/trueforge/scripts/write-openapi.ts                                                         | Builds the SQLite grant store the app deps now require                                                                                                  |
| packages/trueforge/src/db/postgres/types.ts                                                         | `mcp_tool_grant` table type and the `mcp_server.first_party` column                                                                                     |
| packages/trueforge/src/db/sqlite/types.ts                                                           | Same two types, with SQLite's 0/1 integer for `first_party`                                                                                             |
| packages/trueforge/src/db/postgres/schema.ts                                                        | `mcp_tool_grant` in `TABLES_TO_MOVE`                                                                                                                    |
| packages/trueforge/src/truefoundry/TrueFoundryMcpServerStore.ts                                     | Gateway-managed servers are never first-party                                                                                                           |
| packages/trueforge/src/db/postgres/mcp-server-store/PostgresMcpServerStore.ts                       | Reads and writes `first_party`                                                                                                                          |
| packages/trueforge/src/db/sqlite/mcp-server-store/SqliteMcpServerStore.ts                           | Same, mapping SQLite's 0/1 integer to a boolean                                                                                                         |
| packages/trueforge/.env.example                                                                     | `FIRST_PARTY_MCP_ORIGINS`                                                                                                                               |
| packages/trueforge-core/tests/core/mcp/remoteMcpServer.test.ts                                      | Effect classification follows the explicit `openWorldHint: false` rule                                                                                  |
| packages/trueforge/tests/db/mcpServerStoreContractSuite.ts                                          | `first_party` is written as given and read back                                                                                                         |
| packages/trueforge/tests/unit/apis/mcpServers.test.ts                                               | Tool grants on URL change and delete; the provider check refuses redirects                                                                              |
| packages/trueforge/tests/unit/runtime/getMcpConnection.test.ts                                      | The first-party marker through the origin list                                                                                                          |
| packages/trueforge/tests/unit/apis/capabilities.test.ts                                             | Server records carry the required `first_party`                                                                                                         |
| packages/trueforge/tests/unit/runtime/sessionResources.test.ts                                      | Same                                                                                                                                                    |
| packages/trueforge/tests/unit/truefoundry/perServerMcpHeaders.test.ts                               | Same                                                                                                                                                    |
| packages/trueforge/tests/unit/truefoundry/TrueFoundryMcpServerStore.test.ts                         | Same, plus a gateway-managed server is never first-party                                                                                                |
| packages/trueforge/tests/unit/apis/mcpOAuth.test.ts                                                 | Router is built with the new `toolGrantStore`                                                                                                           |
| packages/trueforge/tests/unit/apis/modelProviders.test.ts                                           | Same                                                                                                                                                    |

## Product docs (resolution: ours)

| Path                 | Why                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README.md            | Aman product README and architecture; upstream's README describes TrueForge itself                                                                                                                                                                                                                  |
| docs/quickstart.mdx  | Rewritten for a from-scratch Amanuensis install (this repo's clone URL, no published `npx` package, prerequisites, model connection including Ollama, troubleshooting); upstream's version documents installing upstream TrueForge itself, including its own published `npx`/Helm/Railway artifacts |
| docs/mcp-servers.mdx | Adds which tools ask first and the first-party origin list; upstream's page covers connecting a server only                                                                                                                                                                                         |

Compaction triggers (#400): resolved to upstream's `trigger: { type: 'input_tokens', value }` shape.
`builtinsFromSpec.ts` already reads `config.context_management.compaction.trigger?.value`; the fork's
old flat `compaction_threshold_tokens` field is gone. One leftover test
(`packages/trueforge-core/tests/agent-session/compactionModelRole.test.ts`) still built an AgentSpec
with the old field name, updated it to the `trigger` shape; no other reference to the old field
remains anywhere in the tree.

## Compaction correctness (resolution: ours, upstream layered in)

| Path                                                                                                                                                                        | What we changed                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| packages/trueforge/src/config.ts, packages/trueforge/.env.example                                                                                                           | `CONTEXT_COMPACTION_THRESHOLD_TOKENS` is now `number \| undefined` (unset stays unset) instead of defaulting to 50000, so the context-length ratio in `resolveCompactionThresholdTokens` is reachable. An explicit env value still wins. Added `parseOptionalPositiveInt`.                                                     |
| packages/trueforge-core/src/core/capabilities/builtins/ContextCompaction.ts                                                                                                 | Summarization transcript includes prior compaction summaries and tool calls (name, compact arguments) paired with results; the request is bounded to the model context by cutting the largest messages (marked as truncated); a throwing or oversized summarizer falls back to truncation, which now keeps the latest summary. |
| packages/trueforge-core/src/core/events/schema.ts                                                                                                                           | `ContextCompactionEvent.reason` gains `summarizer_failed` and `request_too_large` (outcome stays `truncated_fallback`). Generated OpenAPI and SDK copies follow from CI regeneration.                                                                                                                                          |
| packages/trueforge-core/src/agent-session/schemas/agentSpec.ts                                                                                                              | `CompactionConfig` description states the real default (80% of context length, capped for the output reserve and floored at 4000, else 50000).                                                                                                                                                                                 |
| packages/trueforge-core/src/agent-session/builtinsFromSpec.ts, ITurnResourceResolver.ts                                                                                     | Comments: an undefined host default now means the context-length ratio, not a fixed 50000. Both use the new `CompactionModel` type.                                                                                                                                                                                            |
| packages/trueforge-core/src/agent-session/TurnResourceResolver.ts, packages/trueforge/src/runtime/PersonaTurnResourceResolver.ts, packages/trueforge-core/src/core/index.ts | The compaction model now carries its `modelProperties` (new `CompactionModel` type) so the summarizer request is bounded by its own context length; dropped the unused `DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS` export.                                                                                                   |
| packages/trueforge-core/src/core/llm/VercelAILLM.ts, runtime/AgentThread.ts (new `core/llm/maxOutputTokens.ts`)                                                             | `resolveMaxOutputTokens` had two copies (here and in ContextCompaction.ts); it now lives in one leaf module and both import it. Invalid limits (NaN, infinite, negative) now resolve to undefined in the model request too.                                                                                                    |

## Autonomy, sessions, rebrand (entries to be confirmed)

First-sync conflict manifest hits these surfaces; annotate why and the
winning side per file before resolving:

| Path                                                                                                                           | Overlapping upstream change      | Resolution               |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------ |
| packages/trueforge-core/src/agent-session/builtinsFromSpec.ts                                                                  | Compaction triggers (#400)       | resolved: upstream       |
| packages/trueforge-core/tests/.../ContextCompaction.test.ts, resolveAgentSpec.test.ts                                          | Compaction triggers              | resolved: upstream       |
| packages/trueforge-core/src/agent-session/models/SessionRecord.ts, schemas/session.ts, store/InMemorySessionStore.ts, index.ts | Session metrics (#478/#479/#484) | merge (confirm first)    |
| packages/trueforge/src/apis/sessions.ts, db session stores and types (both backends), tests/unit/apis/sessionHttp.test.ts      | Session metrics                  | merge (confirm first)    |
| packages/trueforge/src/app.ts, main.ts, routes/openapiTags.ts                                                                  | Schedules dispatch (#472/#517)   | merge                    |
| packages/trueforge-ui/src/containers/ThreadListContainer.tsx, TrueForgeUIShell.tsx, theme/brand.tsx                            | Branding (#428) vs Aman rebrand  | merge (confirm first)    |
| packages/frontend/src/App.tsx                                                                                                  | Upstream refactors vs rebrand    | merge (confirm first)    |
| packages/trueforge-ui/...types.ts, test/publicUiExports.test.ts, test/containers/ComposerContainer.test.tsx                    | Upstream refactors               | merge                    |
| Dockerfile.dev, package.json files, pnpm-workspace.yaml                                                                        | Dist-free dev refactor (#530)    | merge (small, toolchain) |

## Frontend auth / boot (resolution: ours, upstream layered in)

| Path                                                      | Why                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/frontend/src/authSession.ts, App.tsx             | merge. Per-user draft storage is now scoped by `subject.id` (`subjectId`) rather than email, because the SDK's `/me` response no longer reports an email. Accepted as-is; if a scope migration for existing local drafts keyed by email is ever needed, handle it separately.                        |
| packages/frontend/src/App.tsx (`openSettings`)            | ours. Boot forces Settings open (`openSettings: true`) when no model is configured yet, so the user can add one immediately; kept this behavior through the merge (`openSettings: false` once a model catalog entry exists).                                                                         |
| packages/frontend/src/NewAgentWelcomeScreen.tsx (removed) | Dead code after the merge, `App.tsx` now wires `WelcomeScreen: AmanWelcome` directly and nothing else referenced `NewAgentWelcomeScreen` or its `.new-agent-welcome` CSS hook. Removed the component and the now-unused CSS rule in `packages/frontend/src/index.css` (AGENTS.md forbids dead code). |

## UI chrome and chat atoms (resolution: ours, upstream layered in)

| Path                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| packages/trueforge-ui/src/server/serverChrome.ts (`isSettingsChromeEnabled`)                  | ours. Upstream's merge draft required `capabilities.settings.enabled === true` before showing the Settings button. Our frontend and some instances do not send that capability at all, which would hide Settings after the sync. Changed the check to `!== false` so an absent or missing capability defaults to visible; only an explicit `false` hides it. Added a default-enabled case to `packages/trueforge-ui/test/server/serverChrome.test.ts`.                                                 |
| packages/trueforge-ui/src/atoms/ShellActions.tsx (`BugReportButton`)                          | ours. `BugReportButton` is a fork-only control (no upstream counterpart); preserved unconflicted through the merge alongside upstream's other `ShellActions` additions.                                                                                                                                                                                                                                                                                                                                |
| packages/trueforge-ui/src/atoms/ToolApprovalBar.tsx                                           | ours. The radio-group approval design (`guidance`, `hostObservedTargetSummary` props, `role="radiogroup"`) is fork-only and unconflicted; the only merge conflict was a `Button` `size` prop token (`"sm"` upstream vs `"small"` ours), took upstream's `"small"` token since that's what the shared `Button` primitive now expects.                                                                                                                                                                   |
| packages/trueforge-ui/src/atoms/SandboxToolCallCard.tsx                                       | merge. Kept our `outcomeText` prop/rendering; layered in upstream's additive `approvalSlot`/`approvalId` props (approval-banner scroll/flash targeting) on top, since they don't touch `outcomeText`.                                                                                                                                                                                                                                                                                                  |
| packages/trueforge-ui/src/containers/AssistantMessageContainer.tsx                            | ours. One added element, `RunCodeSetupNoticesContainer`, sits between the agent-details disclosure and the final text, so a run_code setup failure (Docker, image, daemon or isolation) stays visible while agent details are collapsed. The notice, its result parser and its link splitter are fork-only files; on a sync conflict keep upstream's body and re-add that element with its import.                                                                                                     |
| packages/trueforge-ui/src/atoms/UserMessageBubble.tsx                                         | merge. Kept our `aman-chat-text` class on the message bubble; adopted upstream's change to skip rendering the bubble entirely when `text` is empty/whitespace-only.                                                                                                                                                                                                                                                                                                                                    |
| packages/trueforge-ui/src/containers/ThreadContainer.tsx                                      | merge. Kept our existing thread shell structure; adopted upstream's `ApprovalFocusProvider` wrapping (needed by the new approval-nav banner/hooks elsewhere in this sync) and its expanded `welcomeHeading` logic for the create-agent flow.                                                                                                                                                                                                                                                           |
| packages/trueforge-ui/src/containers/SettingsBuilder/AddMcpServerForm.tsx, MemorySettings.tsx | ours behavior, upstream API shape. The merge draft had `AddMcpServerForm` accept both `onSubmit` (upstream) and `onAdd` (ours) as a forwarding shim, which the repo forbids. Removed `onAdd` and made `onSubmit` required; migrated `MemorySettings.tsx`'s one remaining `onAdd={handleSave}` caller to `onSubmit={handleSave}`.                                                                                                                                                                       |
| packages/trueforge-ui Button `size` prop, repo-wide                                           | upstream. The shared `Button`/`auiButtonClass` size union changed to `'small' \| 'large' \| 'icon'`. Swept `size="sm"`/`size="lg"` (JSX prop form) and `size: 'sm'` (object-literal `auiButtonClass(...)` call form) across `packages/trueforge-ui/src` and `test` and changed every Button-primitive call site to `'small'`/`'large'`; left `Avatar` and `SideDrawer` alone since their own `size` unions still use `'sm'`/`'lg'`/`'md'`/`'xl'` and were not touched by the upstream `Button` change. |
| packages/trueforge-ui/src/containers/SettingsBuilder/ConnectorSettings.tsx ("Replace Key")    | upstream. Removed our "Replace Key" control; upstream's Edit flow (open the same form pre-seeded, leave the key field blank to keep the stored credential) already covers the same case.                                                                                                                                                                                                                                                                                                               |
| packages/trueforge-ui/src/atoms/ComposerSections.tsx, atoms/draft/DraftComposerSections.tsx   | ours. Voice input is fork-only: `ComposerRightSection` hosts `VoiceInputButton`, and `DraftComposerRightSection` renders that section after its selectors so the mic shows in both composer modes. Keep both on a sync; taking upstream's draft section alone drops the mic from the draft composer, which is the one the app always uses.                                                                                                                                                             |

`packages/trueforge-ui/src/containers/AssistantMessageContainer.tsx` and `utils/computeAgentStepsSplit.ts` (ours): substantive text before a tool call stays in the main flow, and each contiguous run of tool calls, reasoning and short narration is its own `AgentInternalsDisclosure` in part order, so a full answer written before a verifying search is not hidden in the collapsed details. `computeAgentStepsSplit` returns `runs` instead of a single `cutIndex`. On a sync conflict keep upstream's body and re-apply this.

## Theme tokens and the theme-token guard (resolution: ours, upstream layered in)

`pnpm lint:theme` fails on fixed colors in `packages/trueforge-ui/src` and `packages/frontend/src`, so these upstream files read colors from theme tokens instead of palette classes or literals. On a sync conflict, keep upstream's structure and re-apply the token usage; do not take upstream's palette classes back.

| Path                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/trueforge-ui/src/theme/types.ts, theme/presets/index.ts, src/styles.css                                                                                                                                                                                             | ours (additive). Added vivid status tokens (`success`, `warning`, `danger`/`dangerBg`, `info`/`infoBg`, `recording`) and data-series tokens (`chart1` to `chart8`) to `SemanticTokens`/`TOKEN_CSS_VARS`, with values in all 8 presets for light and dark, plus `@theme inline` Tailwind registrations. No existing token value changed, including every preset's `overlay`. On a sync conflict, keep upstream's token list and re-add ours. |
| packages/trueforge-ui/src/atoms/AgentsLibrary.tsx, atoms/schedules/ScheduleRunChip.tsx, ScheduleStatusBadge.tsx, TestScheduleScreen.tsx                                                                                                                                      | ours. Status badges and dots use `success`/`warning`/`danger` token classes (`text-success`, `bg-success/10`, ...) instead of `emerald`/`amber`/`red` palette classes with `dark:` variants; the tokens already carry the light and dark values.                                                                                                                                                                                            |
| packages/trueforge-ui/src/atoms/primitives/CenteredModal.tsx, SideDrawer.tsx, atoms/AttachmentCard.tsx                                                                                                                                                                       | ours. Backdrops and the attachment remove button use `bg-[var(--overlay)]` instead of `bg-black/50` with a `dark:` variant, so each preset controls its own scrim. The remove button lost its `hover:bg-black/70` state.                                                                                                                                                                                                                    |
| packages/trueforge-ui/src/atoms/agent-details/AgentMetricChart.tsx, AgentSessionEventTimeline.tsx, AgentSessionEventTimelineChart.tsx, AgentSessionTimelineTooltip.tsx, utils/sessionEventTimeline.ts, utils/buildSessionMetrics.ts, test/utils/sessionEventTimeline.test.ts | ours. Timeline event types map to `--chart-N` in legend order, and chart axis, grid and series colors come from theme tokens. Canvas code reads the live CSS variable through the fork-only `utils/chartThemeColors.ts` and falls back to the default preset, so there is one owner for the palette. This replaces upstream's hex registry; `SESSION_EVENT_TYPES` keeps its shape.                                                          |
| packages/frontend/src/index.css                                                                                                                                                                                                                                              | ours. Dropped the hex fallbacks inside the `.boot-screen` `var(--text-secondary)`, `var(--primary-bg)` and `var(--failure-bg)` reads; the boot screens always render inside `ThemeProvider`, so the variables are set. The pre-hydration body paint and the brand gradient stay literal and are allowlisted line by line.                                                                                                                   |

## Sync 2026-09-13: additional judgment calls

Beyond the entries above (compaction triggers resolved to upstream; router migration to
`resolveRequestContext`/`hasAdminRole`/`resolveModelProviderStore` confirmed already done by
earlier agents in this sync):

- `packages/trueforge/src/db/McpServerWithAuthStore.ts` (`resolveAuthStatuses`,
  `deleteAuthorization`) and `packages/trueforge/src/schemas/mcpServer.ts`
  (`resolveMcpAuthStatus`) only recognized `dcr` as token-backed; `oauth_client` (fork-only) shares
  the same token flow (see the existing `authorize()`/`resolveInvokeHeaders()` entry above) but was
  left out of these three, so an `oauth_client` server's auth status always read `not_required` and
  its token was never cleaned up on delete. Extended all three to treat `oauth_client` the same as
  `dcr`.
- `McpServerWithAuthStore`, `TrueFoundryMcpServerStore` (`deleteServer`),
  `TrueFoundryModelProviderStore` (`deleteProvider`), `TrueFoundrySkillStore` (`deleteSkill`) were
  missing the delete methods their interfaces (`IMcpServerStore`, `IModelProviderStore`,
  `ISkillStore`) now require, added pass-through / `trueFoundryManaged()` implementations
  matching the sibling methods already on each class.
- `beginTurnExecution`/`startTurnInProcess` (the schedule-run turn engine in
  `packages/trueforge/src/apis/turns.ts`) used a bare `setTimeout` instead of the chat path's
  `TurnExecutionDeadline` (armed, extendable by registered command execution, disposed on drain
  end) and never populated `TurnEventDrainInput.memory`, so a scheduled run's retain never fired.
  Rewired `beginTurnExecution` to construct and arm a `TurnExecutionDeadline` exactly like the
  chat handler and to build the `memory` drain input when `deps.memoryClient` is set.
  `ScheduleTurnExecutionDeps` (`schedules.ts`) already threaded `tokenStore`, `repositoryStore`,
  `sessionStore`, `sandboxProviderResolver` through to `startTurnInProcess` from an earlier point
  in this sync; personalization/persona context resolution for scheduled runs (building
  `personalizationContext`/`personaContext` from a profile the way the chat handler does) is not
  wired and stays a gap, `beginTurnExecution` accepts both as optional pass-through fields but
  nothing populates them for a schedule run today, same as before this sync.
- Fixed a batch of merge-only compile breaks unrelated to any behavior decision: `SessionRecord`'s
  `created_by` → `created_by_subject.subject_id` rename left stale in
  `packages/trueforge-core/src/agent-session/SessionHandle.ts`,
  `store/InMemorySessionStore.ts`, and `packages/trueforge/src/apis/turns.ts`; several
  `packages/trueforge-core` tests building `SessionsCreateInput` with the old flat `created_by`
  field (needed `created_by_subject` + the newly-required `external_id: null`); `SkillMounter.ts`'s
  `skillPrerequisites()` read `.requires` off the `Skill` union before narrowing to `GitSkill`;
  `packages/trueforge/src/schemas/skillCatalog.ts`'s `CatalogSkillSchema` was missing the fork's
  `requires` field entirely (shipped-catalog YAML has `requires:` on a couple of entries, so
  `SkillCatalog.load()` threw); `packages/trueforge/src/db/{postgres,sqlite}/session-store/queries/implementationPlanGrants.ts`
  filtered the `session` table by a `created_by` column that no longer exists (same rename;
  switched to `json_extract(created_by_subject, '$.subject_id')` / `created_by_subject->>'subject_id'`);
  several `packages/trueforge/src/apis/*.ts` routers (`modelProviders.ts`, `sandboxProviders.ts`,
  `skills.ts`) had delete handlers written against the pre-sync bare-store `ServerDeps` shape
  (`deps.modelProviderStore`/`TENANT_ID`) instead of the resolver-based shape
  (`deps.resolveModelProviderStore(c)`/`requestContext.tenant_id`) the rest of this sync moved to;
  `packages/trueforge/tests/fixtures/approvalTestServer.ts` built `ServerDeps` against the same
  pre-sync shape (missing `resolveModelProviderStore`/`resolveMcpServerStore`/`resolveAgentStore`/
  `resolveImportAgentStore`/`resolveSkillStore`/`resolveSandboxProviderStore`, `scheduleStore`,
  `sessionMetricsStore`, `authenticator`, `authorizer`) and needed rebuilding to match
  `main.ts`'s standalone-mode wiring; `mcpServers.ts`/`memoryProvider.ts` accessed
  `manifest.memory_provider`/`memory_settings` (fork-only, `RemoteMcpServerManifest`-only fields)
  without narrowing off the `truefoundry` manifest variant first; `routes/mcpServerRoutes.ts` had
  a duplicate local `McpAuthorizeQuerySchema` shadowing the one upstream lifted into
  `schemas/mcpServer.ts`; `db/sandboxProviderStore.ts` referenced a `SandboxProviderManifest` name
  that doesn't exist (meant `StoredSandboxProviderManifest`); a handful of `Sessions`/
  `SessionHandle`/`TurnHandle`/`ISessionStore` call sites across `turns.ts`, `app.ts`,
  `agentImport.ts`, `permissions.ts`, `authorizer.ts`, `scheduleDispatch.ts`, `schedules.ts`, and
  `sessionResources.ts`'s `buildGatewayMetadata` used the bare (default-generic) type instead of
  `<SessionCustom, TurnCustom>`, which no longer structurally matches now that `TurnCustom` carries
  real fields (persona snapshot, manual-activation id).
- `packages/trueforge/src/runtime/sessionResources.ts`'s `getMcpConnection` reimplemented the
  DCR/oauth_client header flow inline (`dcrHeadersResolver`, a local `resolveMcpAuth` call) instead
  of delegating to `store.resolveInvokeHeaders()`, the single owner the store-owns-DCR refactor
  documented above (`McpServerWithAuthStore` entry, this file) already established. That bypassed
  `TrueFoundryMcpServerStore`'s gateway-specific `resolveInvokeHeaders` override (mid-turn
  re-authorization through the TrueFoundry gateway, distinct from the generic DCR flow) for any
  caller holding a with-auth store, silently falling through to the wrong header resolution.
  Changed `getMcpConnection` to call `store.resolveInvokeHeaders({ record, userRef })` when the
  manifest needs live auth (`dcr`/`oauth_client`) and the store implements
  `IMcpServerWithAuthStore`; kept the local `dcrHeadersResolver` only as the fallback for a caller
  holding the bare `IMcpServerStore` with `tokenStore`/`clientName` supplied directly. A header/
  no-auth manifest still always takes the static `resolveManifestRequestHeaders` path (secret-
  reference resolution/validation that `resolveInvokeHeaders` does not do), regardless of store
  type.
- Silent-drop sweep (all 32 fork identifiers listed in the task): every one is present with a real
  definition and real call site, none reduced to a stray comment or unused import. Test file counts
  per package (`packages/trueforge-core` 112 vs origin/main's 107, `packages/trueforge` 139 vs 105,
  `packages/trueforge-ui` 219 vs 161, `packages/frontend` 11 vs 10) all increased, none decreased.

## Standing dependency patches

| Patch                                                   | Why                                                                                | Sync note                                                                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| patches/@truefoundry__assistant-ui-runtime@0.1.37.patch | Tool-call mapping, approval options, memory settings, `oauth_client` MCP auth type | Regenerated against 0.1.37 from a pristine `npm pack` tarball, no rename/similarity headers; pnpm registers it under `patchedDependencies` and `pnpm-lock.yaml` carries its hash |

`@truefoundry/assistant-ui-runtime` is pinned at 0.1.37 (bumped from 0.1.21 in this merge, needed
for the session-metrics/schedules/permissions-server types the merged `packages/trueforge-ui` code
uses: `AgentMetricsServer`, `AgentSessionsServer`, `ScheduleServer`, `PermissionsServer`). The
0.1.37 patch carries every fork-only addition the 0.1.21 patch had: the `oauth_client` connector
auth variant, `MemoryRuntimeConfig`/`memory` on `AgentRuntimeConfig`, `auxiliaryModels` on
`AgentSpec`, approval scope (`once`/`chat`), `ToolResponseEventV2`/tool-result disposition,
per-invocation tool-call scoping (`toolCallInvocations`), and `terminalError` surfaced through
`useTrueFoundryTerminalError`, reapplied by hand against 0.1.37's `dist/*.d.ts`, its bundled
`dist/index.js`, and the shipped `src/*.ts`, since none of it landed upstream between 0.1.21 and
0.1.37. `sandbox` on `AgentRuntimeConfig` is no longer part of the patch: 0.1.37 types it natively
as `AgentSandboxConfig`, which is why `dfb2d3e3` could stop reading it via `Reflect`.

`packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/chatServer.ts` had a duplicate
`deleteSession` method left over from the merge (two identical implementations); removed the
second. Its `toUiEventItem` also built a session-history event by spreading the SDK's raw
`turn.done` event instead of routing it through `toUiSessionEvent`, the helper that clamps
optional SDK token counts to the runtime's now-required `TurnDoneMetrics` fields; switched it to
call that helper, matching what `toUiStreamingEvent` already did for the live stream.

**SDK state:** `packages/trueforge-sdk` is the Fern output committed against the merged OpenAPI
document (see the Generated artifacts table above); `client.internal`, `client.schedules`,
`SessionMetricsChartName`, `ScheduleManifest`, `Schedule`, `ScheduleRun`, and
`metadata`/`metrics`/`source` on `Session`, `description`/`createdBySubject` on `Agent`, `preload`
on `Skill`, and list-response pagination helpers all resolve against it; `packages/trueforge`
passes `tsc --noEmit` cleanly.

The fork's `packages/trueforge/src/schemas/events.ts` widens the session-event union (for
`aman.memory.recall` / `aman.profile.learned` passthrough events). The widened union is named
`SessionEvent` and its item wrapper `SessionEventItem` through `.openapi()`, so Fern emits those
reusable types instead of per-endpoint inlined ones, and `packages/trueforge/src/schemas/turn.ts`
reuses the same named schema. `packages/trueforge-sdk` is regenerated from this document.

The committed `packages/trueforge-sdk` also carries two settings-surface manifest unions with a
`truefoundry`-managed variant alongside the existing `remote` one:
`TrueForgeApi.SkillManifest` (skill catalog) and `TrueForgeApi.McpServerManifest`
(`memoryProvider`/`memorySettings` only exist on the `remote` variant). Every read site in
`packages/trueforge-ui` (`skillCatalog.ts`, `lists.ts`) and `packages/trueforge`
(`mcpServers.test.ts`, `memoryEnforcement.test.ts`) narrows on `.type === 'remote'` /
`.type !== 'git'` before touching the conditional fields, rather than casting past the union.

Two local component-API mismatches are fixed, not routed around:
`AuiButtonVariant` (`packages/trueforge-ui/src/atoms/lib/buttonClasses.ts`) has
`'primary'`/`'secondary'`/`'ghost'`/`'destructive'` (matching upstream's own `Button`), so the
five fork call sites that passed `'default'`/`'outline'` use the variant that matches their place
in the UI (`'primary'` for the emphasized action, `'ghost'` for an inline row action).
`MascotAnimator.tsx`'s `mascotActionFor` treats the fork's `'custom'` (a custom action renderer
pending) and `'approval'` (a tool approval pending) pause kinds as the same "blocked on the user"
case as `'mcp'`/`'ask-user'`, so all four resolve to the `waiting` mascot action.

**Regenerating `packages/trueforge-sdk` runs on Linux.** On this Windows host the working path is
the WSL Ubuntu distro as root with the tarball Node under `/opt/node-v22.23.2` (see
`docs/UPSTREAM_SYNC.md`): bundle the branch (`git bundle create`), clone the bundle inside WSL,
`pnpm install --frozen-lockfile`, build `@truefoundry/trueforge-sdk` and `@truefoundry/trueforge-core`
first (the OpenAPI writer imports the SDK's built output), then `pnpm sdk:generate`, and copy the
changed files back. Native Windows Git Bash fails inside Fern's generator (it writes the
container bind-mount destination with backslashes), and a non-root WSL session cannot use the
prepared toolchain; both fail closed because `scripts/generate-sdk.sh` restores the verified backup.

**typescript-eslint is held at 8.68.0, upstream's own lock resolution.** The root `package.json`
range is `^8.68.0` as upstream has it; 8.70.0 changed `@typescript-eslint/no-meaningless-void-operator`
to flag the `void unusedParam;` idiom that upstream's own code uses in migrations, the
`truefoundry/*` stores and `apis/sandboxProviders.ts`, which would fail `pnpm lint:ci` on 86
sites. Bump it together with upstream when upstream's lock moves.

`packages/trueforge/src/apis/sandboxProviders.ts`'s `performImageUpgrade` had one unrelated
`prefer-optional-chain` lint error (`existing === undefined || existing.manifest.type !== ...`)
under `typescript-eslint` 8.68.0; rewritten as `existing?.manifest.type !== ...`, same
short-circuit, so `pnpm lint:ci` is clean end to end.

Regenerating the SDK against the named `SessionEvent`/`SessionEventItem` schemas surfaced one
more shape gap in `packages/trueforge-ui`: the vendor `@truefoundry/assistant-ui-runtime` event
unions (`TurnEvent`, `TurnStreamingEvent`, `SessionEventItem['event']`) have no case for
`tool.execution_started` or any of the four passthrough event types
(`aman.memory.recall`, `aman.profile.learned`, `agent.context.compaction`, `document.ingestion`).
`chatServer.ts` already excluded exactly these five from the chat port with explicit
`if (type === ...) return undefined;` guards before spreading an event into the vendor shape;
`toUiSessionEvent`/`toUiStreamingEvent` (`toUiTurnState.ts`) did not carry that exclusion in their
own parameter types, so their internal `{ ...event }` spread type-checked against the full SDK
union and failed once the SDK started emitting the real, named event types (it previously failed
silently in the other direction, against inlined per-endpoint types that happened to structurally
absorb the mismatch). Narrowed both functions' parameter types with
`Exclude<..., { type: VendorIncompatibleEventType }>`, so the exclusion callers already perform
is now visible to the type checker instead of relying on a cast. The same gap existed,
unnoticed, on the admin/metrics `AgentSessionsServer.listSessionEvents` port
(`agentSessionsServer.ts`), which called the unfiltered `toUiEventItem` export from
`toUiTurnState.ts` with no exclusion at all; gave that export the same five-way exclusion
`chatServer.ts`'s local copy already has, and switched its caller from `toListResult` (a strict
1:1 map) to a `flatMap`-based filter, matching the chat port's own `listEvents`.

`packages/frontend/src/App.tsx`'s `AMAN_THEME.brand` also needed a `mode` once `BrandConfig`
picked up the merge's `icon-title` / `icon-only` / `logo` discriminated union (previously a bare
`{ name }` was legal); set `mode: 'icon-title'` to keep the prior look (a text title beside the

## Greening the trueforge-ui/frontend suites post-sync

`pnpm test:trueforge-ui` had 11 failing suites (23 tests) after the sync; `pnpm test:frontend`
passed once its `pretest` build ran. Fixed at the root rather than per test:

- **jsdom's `<dialog>` gap (resolution: shared setup, not per-test stubs).**
  `packages/trueforge-ui/test/testSetup.ts` now polyfills
  `HTMLDialogElement.prototype.{show,showModal,close}` once for the whole suite (toggling the
  `open` attribute and firing a `close` event, matching what the UA does), since jsdom renders
  `<dialog>` but leaves those methods as no-ops. This fixed every test that opens a modal built on
  `CenteredModal` (`ConnectorSettings`, `AddMcpServerForm`) without touching them. A handful of
  suites (`Dialog.test.tsx`, `CenteredModal.test.tsx`, `BottomSheet.test.tsx`, `SideDrawer.test.tsx`)
  keep their own `vi.fn()`-based overrides because they assert directly on `showModal`/`close`
  call counts; those are spies for a specific behavior, not gap-fill, so they stay.
- **Branding (resolution: fork's Amanuensis brand is the truth).**
  `test/containers/TrueForgeUI.test.tsx` and `test/theme/brand.test.tsx` asserted upstream's
  TrueForge wordmark (name, and a light/dark-specific `viewBox`); the fork ships one inline
  `DefaultMark` glyph (`viewBox="0 0 120 120"`, `aria-label="Amanuensis"`) for both the `icon` and
  `logo` variants with no light/dark split (see `src/theme/brand.tsx`). Updated both tests to
  assert the fork's actual mark instead of deleting upstream's coverage.
- **`isSettingsChromeEnabled` default-enabled (resolution: fork's decision, already recorded
  above under "UI chrome and chat atoms").** `test/server/settingsChrome.test.ts` (the deprecated
  re-export's own test, distinct from `serverChrome.test.ts`) still asserted the old
  capability-required behavior; updated to match. `test/server/ShellModeContext.test.tsx` and
  `test/routing/ShellRouteSync.test.tsx` had the same drift one layer up: with an absent capability
  now defaulting to enabled, `initialSettingsOpen`/a `/settings` deep link is honored as soon as a
  catalog exists, without waiting on the capability fetch, and a _failed_ capability fetch (which
  leaves capabilities at that same null default) no longer unregisters `/settings` either. Updated
  the three tests' expectations and titles to state the new behavior instead of the old one.
- **`ShellRouteSync` boot-place bug (real bug, fixed in source).** Closing a `/settings` deep link
  stayed stuck on `/settings` instead of returning to `/`: the effect that mirrors shell state back
  onto the URL skips navigating on its first run after boot (boot already set the URL), but that
  first run is also, in the common case, the exact render where shell state catches up with the
  place boot chose. That let the "skip first run" branch return before ever clearing
  `bootPlaceRef`, leaving it permanently stuck on `{type: 'settings'}` and making every later
  navigation defer to a boot place that had already been reached. Fixed in
  `src/routing/ShellRouteSync.tsx` by consuming `bootPlaceRef` as soon as the derived place matches
  it, independent of the first-run skip.
- **Duplicate "Connected" badge (real bug, fixed in source).** `ConnectorSettings`'s configured-
  connector row rendered two badges for the same connector: a plain `connector.authenticated ?
'Connected' : 'Added'` badge folded into `content` by the upstream merge, and the fork's own
  richer, connection-test-aware badge (`Connected` / `Connection failed` / `Unverified` / `Added`)
  rendered right after it. `renderConnector`'s only call site always passes `isConnected: true`, so
  both always rendered together. Removed the plain badge from `content`; the richer one already
  covers every state it did.
- **`AddMcpServerForm` API-key validity bug (real bug, fixed in source).** The Save button's
  `isValid` check used `editing` (true whenever a `connector` or `initialDraft` was seeded) to
  decide a blank API key is acceptable, but `editingHeaderAuth` (true only when the connector
  _already_ used header auth) already existed, correctly gating the input's own `required`
  attribute and placeholder, and `isValid` just never read it. That let a connector edited from
  `none`/`dcr`/`oauth_client` auth onto `header` auth submit with no key at all. Switched the
  header branch of `isValid` to `editingHeaderAuth`. Also updated the "preserves an existing API
  key when left blank" test: a blank key is omitted from the submitted payload (not sent as
  `apiKey: ''`), matching the write path's documented "keep the stored credential" intent.
- **`harnessServer.test.ts` malformed mock event (test bug, not a hang).** The `subscribeToTurn`
  test's `turn.done` SSE mock used camelCase `completedAt`/`requiredActions`; the wire schema's
  "done" state variant is snake_case (`completed_at`/`required_actions`), so the SDK's generated
  parser rejected the event outright. `subscribeWithReconnect`'s catch-and-retry (built for
  transport drops, not malformed payloads) swallowed the resulting `ParseError` and retried with
  backoff, so the symptom was a 5-second test timeout with no error surfaced, not an assertion
  failure. Fixed the mock payload's field names; no source change needed.
- **`ToolCallContainer` and `DraftCompositeSelector` (stale test expectations).**
  `ToolCallContainer.test.tsx`'s two "shows the approval bar" tests still queried
  `getByRole('button', { name: 'Allow' })`; the approval bar is a `radiogroup` of `Allow once` /
  `Deny` radios elsewhere in the same file, so aligned these two the same way.
  `DraftCompositeSelector.test.tsx` inherited an upstream assertion that the Capabilities tab is
  hidden for an invalid model; upstream's `AttachTab` union has no `'capabilities'` variant at all
  (that tab is fork-only, unconditionally rendered), so the assertion never matched fork behavior
  even before this sync. Updated to assert the tab is present.
- **`transformMarkdownSource` leading-newline tests (stale test expectations).** Both display-math
  tests expected a leading `\n\n` before the `$$` block even when the source starts with the `\[`
  opener; `rewriteDisplayMath` deliberately omits that leading blank line at offset 0 (see its own
  comment: "avoid adding an extra leading newline at file start"). Updated the two expectations.

default mark, no custom icon or logo image).

## Durable Sentinel approval tokens (resolution: merge)

Approval tokens persist in an `approval_token` table (SQLite and Postgres) so a pending approval survives a restart and is redeemable on any replica. The Sentinel modules themselves are fork-only; these are the upstream-owned files that carry the wiring. Each edit is additive, so on a sync conflict keep upstream's side and re-apply the listed lines.

| Path                                                         | What we added                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| packages/trueforge/src/main.ts                               | `approvalTokenStore` on `ServerPersistence` (SQLite and Postgres), and `createSentinelServices` replacing the inline services          |
| packages/trueforge/src/db/sqlite/types.ts, postgres/types.ts | `ApprovalTokenTable` and its `Database` entry                                                                                          |
| packages/trueforge/src/db/sqlite/client.ts                   | `shell_binding` in `JSON_RESULT_COLUMNS`                                                                                               |
| packages/trueforge/src/db/postgres/schema.ts                 | `approval_token` in `TABLES_TO_MOVE`                                                                                                   |
| packages/trueforge-core/src/core/index.ts                    | Exports for the approval token store contract and helpers                                                                              |
| packages/trueforge-core/src/core/mcp/executeToolCalls.ts     | Awaits `verifyPreDispatch`, which is async now that redeem hits the database                                                           |
| packages/trueforge/tests/fixtures/approvalTestServer.ts      | Builds the Sentinel services with `createSentinelServices` over the SQLite token store, so tokens are shared across turns and restarts |

## Embedded maps (resolution: ours)

`render_map` and `render_route` (server-side tools, Tier 3, inline map card, same-origin tile proxy) are fork-only. The new files are not listed; these are the upstream-owned files that carry the wiring. Each edit is additive, so on a sync conflict keep upstream's side and re-apply the listed lines.

| Path                                                                                                  | What we added                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/trueforge-core/src/core/permissions/classifier.ts                                            | The maps branch in `classifyTier`: always Tier 3, card naming the quoted places, `destination_host` and `outbound_text`, token bound to the configured hosts. Tool names live in the fork-only `mapsToolNames.ts`, imported by the UI as well |
| packages/trueforge-core/src/core/permissions/networkRequirements.ts                                   | `render_map` and `render_route` registered as needing the network, so offline mode withholds them                                                                                                                                             |
| packages/trueforge-core/src/core/llm/LLMTypes.ts, mcp/ToolSet.ts, permissions/index.ts, core/index.ts | `maps_hosts` on the tool-call info and its pass-through into the classifier; the maps exports                                                                                                                                                 |
| packages/trueforge-core/src/core/runtime/AgentThread.ts, mcp/executeToolCalls.ts                      | The connector binding is read from any tool set that reports one, not only `mcp` tools, so the maps tool set gets the same approval binding                                                                                                   |
| packages/trueforge/src/app.ts, config.ts, auth/middleware.ts, runtime/spaceCapability.ts              | The `/api/maps` tile proxy mount (browser session only), the `MAPS_*` settings, and the maps capability in the space turn resolver                                                                                                            |
| packages/trueforge-ui/src/utils/computeAgentStepsSplit.ts, containers/ToolCallContainer.tsx           | A maps call never folds into agent details; `ToolCallContainer` renders its approval and its inline map card                                                                                                                                  |
| packages/trueforge-ui/src/utils/toolCallParsing.ts, src/styles.css, package.json                      | `parseMapsResult`, the `.maps-card` styles (theme tokens only), and the `leaflet` dependency                                                                                                                                                  |
