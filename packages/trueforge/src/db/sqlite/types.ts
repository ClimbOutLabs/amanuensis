/**
 * Live app schema for the SQLite-backed session store.
 * Migrations must not use this type — use `Kysely<unknown>` instead.
 *
 * JSON payload columns are BLOB JSONB on disk. Reads must project `json(column)`;
 * `ParseJSONResultsPlugin` (configured in createSqliteDb) parses those top-level columns only.
 */
import type {
  AgentSpec,
  CreatedBySubject,
  PersistedTurnEvent,
  SessionMetadata,
  SessionMetrics,
  SessionSource,
  TurnInputItem,
  TurnState,
} from '@truefoundry/trueforge-core/agent-session';
import type { TaskChecklist } from '@truefoundry/trueforge-core/agent-session/schemas/taskChecklist';
import type {
  AgentInfo,
  AgentParent,
  ContextMessage,
  ImplementationPlanGrant,
  JsonValue,
  MCPServerInitInfo,
  SandboxInfo,
  ShellApprovalBinding,
  SubAgentCompletionMarker,
  TaskStateSnapshot,
  Tier2ActionKind,
  ToolCallMemoSnapshot,
} from '@truefoundry/trueforge-core/core';
import type { CurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type { McpServerManifest } from '../../schemas/mcpServer';
import type { ModelProviderManifest } from '../../schemas/modelProvider';
import type {
  SandboxBuildMetadata,
  SandboxBuildStatus,
  StoredSandboxProviderManifest,
} from '../../schemas/sandboxProvider';
import type { ScheduleManifest, ScheduleRunStatus, ScheduleStatus } from '../../schemas/schedule';
import type { SkillManifest } from '../../schemas/skill';
import type { ChatImageOrigin } from '../chatImageStore';
import type { OAuthClient, OAuthPendingAuthorizationData, OAuthServer, OAuthToken } from '../mcpServerStore';

/**
 * Trace-level state for one thread at one turn (`turn_thread.checkpoint`).
 * Total types: `completion` is explicitly null until set — no optional keys.
 */
export interface TurnThreadCheckpoint {
  parent: AgentParent | null;
  completion: SubAgentCompletionMarker | null;
  /** Undefined for rows written before cross-continuation memo persistence. */
  tool_call_memo: ToolCallMemoSnapshot | undefined;
  /** Undefined for rows written before task-state persistence, or when the feature is off. */
  task_state: TaskStateSnapshot | undefined;
}

/** Turn-level checkpoint — threads live in `turn_thread`; only owned top-level keys remain. */
export interface TurnCheckpoint {
  mcp_servers: Record<string, MCPServerInitInfo> | null;
  sandbox_info: SandboxInfo | null;
}

/** Insert via `jsonbBind()`; select via `jsonText()` (parsed at top-level only). */
type JsonbColumn<T extends object | null> = JSONColumnType<T, T | string, T | string>;

/**
 * PRIMARY KEY (session_id)
 * CREATE INDEX session_list_idx ON session (tenant_id, created_at, session_id)
 */
export interface SessionTable {
  tenant_id: string;
  session_id: string;
  /** Caller identity that created the session (immutable after create). */
  created_by_subject: JsonbColumn<CreatedBySubject>;
  /** Optional provenance (e.g. schedule). Null for interactive sessions. */
  source: JsonbColumn<SessionSource> | null;
  /** Named registry binding; XOR with `agent_spec`. */
  agent_id: string | null;
  /** Optional repository checkout bound to this session. */
  repository_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Absolute checkout path used by a repository-bound session. */
  workspace_cwd: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Create-time snapshot of registry agent name for ref bindings.
   * Null for value sessions and orphan/legacy refs after a missed backfill.
   */
  agent_name: string | null;
  /** Inline spec binding; XOR with `agent_id`. */
  agent_spec: JsonbColumn<AgentSpec> | null;
  title: string | null;
  /** FK -> session_folder.id, ON DELETE SET NULL. */
  folder_id: string | null;
  last_turn_id: string | null;
  approval_grants: JsonbColumn<string[]>;
  /** Host-owned durable ordered task state. Null only for rows created before T3. */
  task_checklist: JsonbColumn<TaskChecklist> | null;
  /** Optional unique key within `tenant_id` when set. */
  external_id: string | null;
  custom: JsonbColumn<Record<string, unknown>> | null;
  metadata: JsonbColumn<SessionMetadata>;
  metrics: JsonbColumn<SessionMetrics>;
  created_at: string;
  updated_at: string;
  last_activity_timestamp_ms: number;
}

/** Owner-scoped chat folder. PRIMARY KEY (id). */
export interface SessionFolderTable {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** Per-owner compare-and-swap fence for space writes. PRIMARY KEY (tenant_id, created_by). */
export interface SpaceAggregateTable {
  tenant_id: string;
  created_by: string;
  revision: number;
}

/** A persistent, named, structured page the model creates and updates. PRIMARY KEY (tenant_id, created_by, id). */
export interface SpaceTable {
  tenant_id: string;
  created_by: string;
  id: string;
  name: string;
  purpose: string;
  status: 'active' | 'archived';
  body: string;
  format: 'markdown' | 'html';
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * Bounded snapshots of superseded space revisions, written on every update/revert so a bad
 * write can be read back and restored. PRIMARY KEY (tenant_id, created_by, space_id, revision).
 */
export interface SpaceRevisionTable {
  tenant_id: string;
  created_by: string;
  space_id: string;
  revision: number;
  name: string;
  purpose: string;
  status: 'active' | 'archived';
  body: string;
  format: 'markdown' | 'html';
  created_at: string;
}

/**
 * Append-only Sentinel permission audit log. One row per classified tool call,
 * written before the action executes. PRIMARY KEY (id).
 */
export interface SentinelAuditTable {
  id: string;
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  tier: number;
  tool_name: string;
  description: string;
  outcome: 'logged' | 'ran' | 'approved' | 'denied' | 'auto_denied';
  auto_deny_reason: string | null;
  created_at: string;
}

/** Sentinel approval token, keyed by the sha256 of the token id. PRIMARY KEY (token_hash). */
export interface ApprovalTokenTable {
  token_hash: string;
  action_id: string;
  params_hash: string;
  shell_binding: JsonbColumn<ShellApprovalBinding> | null;
  tenant_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** Per-user Sentinel preferences. PRIMARY KEY (tenant_id, created_by). */
export interface SentinelUserSettingsTable {
  tenant_id: string;
  created_by: string;
  /** SQLite's 0/1 integer boolean. */
  offline_mode: number;
  tier2_auto_allow: JsonbColumn<Tier2ActionKind[]>;
  /** SQLite's 0/1 integer boolean. */
  search_without_asking: number;
  /** SQLite's 0/1 integer boolean. */
  maps_without_asking: number;
  created_at: string;
  updated_at: string;
}

/** Content-addressed artifact bytes, deduplicated by digest within a tenant. PRIMARY KEY (tenant_id, digest). */
export interface ArtifactBlobTable {
  tenant_id: string;
  digest: string;
  size: number;
  mime: string;
  data: Buffer;
  created_at: string;
}

/**
 * Per-turn, per-path artifact index copied from the sandbox once a turn finishes; the download
 * route serves from here so a download outlives the sandbox. `status` is `stored` (digest/size/mime
 * set, bytes live in artifact_blob), `skipped_size` (over SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD, not
 * copied), or `skipped_missing` (the sandbox no longer had the declared path when the turn
 * finished). PRIMARY KEY (tenant_id, session_id, turn_id, path).
 */
export interface TurnArtifactTable {
  tenant_id: string;
  session_id: string;
  turn_id: string;
  path: string;
  name: string;
  status: 'stored' | 'skipped_size' | 'skipped_missing';
  digest: string | null;
  size: number | null;
  mime: string | null;
  skip_reason: string | null;
  created_at: string;
}

/** Re-encoded chat image. PRIMARY KEY (session_id, image_id); UNIQUE (session_id, source_key); session cascade. */
export interface ChatImageTable {
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  image_id: string;
  source_key: string;
  origin: ChatImageOrigin;
  mime: string;
  width: number;
  height: number;
  size: number;
  data: Buffer;
  created_at: string;
}

/** Silent remote image fetches a turn has started. PRIMARY KEY (session_id, turn_id); session cascade. */
export interface ChatImageTurnAllowanceTable {
  tenant_id: string;
  session_id: string;
  turn_id: string;
  silent_attempts: number;
}

/** Global key/value settings shared across tenants (e.g. persisted feature overrides). PRIMARY KEY (key). */
/** "Always allow this tool" grant. PRIMARY KEY (tenant_id, created_by, mcp_server_name, tool_name). */
export interface McpToolGrantTable {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  tool_name: string;
  created_at: string;
}

/** A user's Google login. PRIMARY KEY (tenant_id, created_by). `granted_scopes` is space-separated. */
export interface GoogleConnectionTable {
  tenant_id: string;
  created_by: string;
  client_id: string;
  client_secret: string;
  client_type: 'desktop' | 'web';
  refresh_token: string;
  granted_scopes: string;
  account_email: string | null;
  status: 'connected' | 'needs_reconnect';
  created_at: string;
  updated_at: string;
}

/** The one Google consent a user has in flight. PRIMARY KEY (tenant_id, created_by). `scopes` is space-separated. */
export interface GoogleOAuthPendingTable {
  tenant_id: string;
  created_by: string;
  state_hash: string;
  pkce_verifier: string;
  client_id: string;
  client_secret: string;
  client_type: 'desktop' | 'web';
  redirect_uri: string;
  scopes: string;
  created_at: string;
}

export interface GlobalSettingsTable {
  key: string;
  value: string;
  updated_at: string;
}

/** One row per UTC day (`YYYY-MM-DD`); not tenant-scoped. */
export interface TokenFactoryUsageTable {
  usage_date: string;
  used_tokens: number;
  updated_at: string;
}

/** One row per UTC day and upstream model id; not tenant-scoped. */
export interface TokenFactoryModelUsageTable {
  usage_date: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  updated_at: string;
}

/** Durable grant rows. `revoked_at` blocks future dispatch reservations. */
export interface ImplementationPlanGrantTable {
  tenant_id: string;
  created_by: string;
  session_id: string;
  grant_id: string;
  workspace_cwd: string | null;
  checkout_id: string | null;
  grant: JsonbColumn<ImplementationPlanGrant>;
  created_at: string;
  revoked_at: string | null;
}

export interface ImplementationPlanDispatchTable {
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  grant_id: string;
  workspace_cwd: string;
  checkout_id: string;
  dispatch_id: string;
  state: 'dispatching' | 'completed';
  created_at: string;
  completed_at: string | null;
}

/**
 * PRIMARY KEY (session_id, turn_id)
 * CREATE INDEX turn_list_idx ON turn (session_id, created_at, turn_id)
 */
export interface TurnTable {
  session_id: string;
  turn_id: string;
  first_turn_id: string;
  previous_turn_id: string | null;
  /** JSONB array of turn ids — topology only; not a SQL join key. */
  ancestor_ids: JsonbColumn<string[]>;
  input: JsonbColumn<TurnInputItem[]>;
  state: JsonbColumn<TurnState>;
  checkpoint: JsonbColumn<TurnCheckpoint>;
  custom: JsonbColumn<Record<string, unknown>> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Complete state of one thread at one turn.
 * Context order lives in `turn_thread_context` (no context_ids column).
 * PRIMARY KEY (session_id, turn_id, thread_id)
 */
export interface TurnThreadTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  checkpoint: JsonbColumn<TurnThreadCheckpoint>;
  agent_info: JsonbColumn<AgentInfo> | null;
  current_context_usage: JsonbColumn<CurrentContextUsage>;
  updated_at: string;
}

/**
 * Ordered mapping from a turn_thread to append-only log rows.
 * PRIMARY KEY (session_id, turn_id, thread_id, pos)
 */
export interface TurnThreadContextTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  pos: number;
  append_id: number;
}

/**
 * Pure immutable client-facing event log.
 * PRIMARY KEY (session_id, turn_id, event_id)
 */
export interface SessionEventTable {
  session_id: string;
  turn_id: string;
  event_id: string;
  event: JsonbColumn<PersistedTurnEvent>;
  created_at: string;
}

/**
 * Pure immutable content; no state → no checkpoint field.
 * PRIMARY KEY (append_id) AUTOINCREMENT
 */
export interface ThreadContextLogTable {
  append_id: Generated<number>;
  session_id: string;
  thread_id: string;
  turn_id: string;
  body: JsonbColumn<ContextMessage>;
  created_at: string;
}

/**
 * Per-turn KV snapshot, latest-wins per (turn, thread, key).
 * PRIMARY KEY (session_id, turn_id, thread_id, key)
 */
export interface ThreadCapabilityStateTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  key: string;
  /** JSONB JsonValue, or SQL NULL if cleared. */
  state: ColumnType<JsonValue | null, JsonValue | null | string, JsonValue | null | string>;
  updated_at: string;
}

/**
 * Configured model providers — mirrors the Postgres `model_provider` table.
 * PRIMARY KEY (tenant_id, name)
 */
export interface ModelProviderTable {
  tenant_id: string;
  name: string;
  /** ModelProviderManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<ModelProviderManifest>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured skills — mirrors the Postgres `skill` table.
 * PRIMARY KEY (tenant_id, name)
 */
export interface SkillTable {
  tenant_id: string;
  /** key: natural key within tenant; also duplicated inside `manifest` */
  name: string;
  /** SkillManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<SkillManifest>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured sandbox provider — mirrors the Postgres `sandbox_provider` table.
 * PRIMARY KEY (tenant_id) — at most one row per tenant.
 */
export interface SandboxProviderTable {
  tenant_id: string;
  /** StoredSandboxProviderManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<StoredSandboxProviderManifest>;
  /** Last persisted build status of the release sandbox image. */
  status: SandboxBuildStatus;
  /** Human-readable detail for `status`; null when ready. */
  status_reason: string | null;
  /** SandboxBuildMetadata document (opaque string map); null when the provider has none. */
  build_metadata: JsonbColumn<SandboxBuildMetadata> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Configured agents — mirrors the Postgres `agent` table.
 * PRIMARY KEY (id); UNIQUE (tenant_id, name).
 */
export interface AgentTable {
  /** application-generated (ulid); never re-derived from tenant_id/name */
  id: string;
  tenant_id: string;
  /** natural uniqueness target within a tenant */
  name: string;
  description: string;
  /** AgentSpec document; replaced whole on every upsert */
  manifest: JsonbColumn<AgentSpec>;
  external_id: string | null;
  /** 1 for an agent the host made to run a chat's schedules; agent lists leave these out. */
  host_managed: Generated<number>;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured schedules.
 * PRIMARY KEY (id).
 * FK (agent_id) → agent(id) ON DELETE CASCADE.
 */
export interface ScheduleTable {
  /** application-generated (ulid); FK target for schedule_run */
  id: string;
  tenant_id: string;
  /** FK → agent(id). Immutable. */
  agent_id: string;
  /** Create-time snapshot of registry agent name. */
  agent_name: string;
  /** Display label; not unique. */
  name: string;
  /** Persona a schedule made in a chat runs as; null runs the agent's own assistant. */
  persona_id: string | null;
  /** ScheduleManifest document ({ task, cron, timezone }); replaced whole on update */
  manifest: JsonbColumn<ScheduleManifest>;
  /** `paused` stops triggering and drops the pending run; in-flight runs continue */
  status: ScheduleStatus;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * One row per schedule run, pending or historical — mirrors the Postgres `schedule_run`
 * PRIMARY KEY (id); UNIQUE (tenant_id, schedule_id, name).
 */
export interface ScheduleRunTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  /** FK -> schedule.id, ON DELETE CASCADE */
  schedule_id: string;
  /** the run name: `sched-<unixSeconds>` for cron, `manual-<token>` for run-now */
  name: string;
  scheduled_for: string;
  /** `scheduled` | `triggered` | `failed` | `missed` — length ≤ 16 */
  status: ScheduleRunStatus;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  triggered_at: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

/** One explicitly user-owned profile per tenant/user identity. */
export interface PersonalizationProfileTable {
  tenant_id: string;
  created_by: string;
  assistant_name: string | null;
  assistant_identity: string | null;
  voice_guidance: string | null;
  user_name: string | null;
  address_as: string | null;
  user_profile: string | null;
  pinned_preferences: JsonbColumn<string[]>;
  help_areas: JsonbColumn<HelpAreaId[]>;
  /** Host-maintained learned document; null until the learning pass writes one. */
  learned_profile: string | null;
  /** User switch for the learning pass, stored as SQLite's 0/1 integer boolean. */
  learning_enabled: number;
  revision: number;
  digest: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

/** A user-configured persona: identity, role, and the model selected for it. */
export interface PersonaTable {
  tenant_id: string;
  id: string;
  created_by: string;
  display_name: string;
  aliases: JsonbColumn<string[]>;
  instructions: string;
  model_name: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

/** One canonical invocation key. The primary key enforces owner-scoped uniqueness. */
export interface PersonaNameKeyTable {
  tenant_id: string;
  created_by: string;
  normalized_key: string;
  persona_id: string;
}

/**
 * Append-only persona decision log for one chat. Highest `seq` = active
 * persona; a row with `turn_id` records the selection made for that turn. No
 * FK to `persona`: deleting a persona must not rewrite historical selections.
 * FK to `session`: deleting a session removes its private selection history.
 * PRIMARY KEY (tenant_id, session_id, seq)
 */
export interface SessionPersonaTable {
  tenant_id: string;
  session_id: string;
  /** Per-session ordering; assigned by the store, never derived from a clock. */
  seq: number;
  /** Stable opaque identifier for the wire. */
  id: string;
  turn_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  model_name: string | null;
  source: string;
  created_at: string;
}

/**
 * PRIMARY KEY (id)
 * UNIQUE (tenant_id, name) — the natural lookup key;
 */
export interface McpServerTable {
  /** application-generated (ulid); FK target, never re-derived from tenant_id/name */
  id: string;
  tenant_id: string;
  /** the uniqueness target; also duplicated inside `manifest` */
  name: string;
  manifest: JsonbColumn<McpServerManifest>;
  /**
   * Both null until the first successful DCR registration, written together in that one call;
   * always null when `manifest.auth` is absent. Two columns rather than one blob: different
   * source HTTP response (metadata discovery vs. registration), and only `oauth_client` carries
   * a secret.
   */
  oauth_server: JsonbColumn<OAuthServer> | null;
  oauth_client: JsonbColumn<OAuthClient> | null;
  /** 0/1 (defaults to 0), never client-supplied: 1 only for a connector the product's own setup provisioned. */
  first_party: Generated<number>;
  created_at: string;
  updated_at: string;
}

/**
 * PRIMARY KEY (oauth_server_id, user_id)
 * No `tenant_id` — already scoped to tenant via the FK. Tokens are per harness user
 * (`user_id` = `RequestContext.subject.id`); any tenant-scoped read resolves `oauth_server_id`
 * through mcp_server (by tenant_id + name) first.
 */
export interface OAuthTokenTable {
  /** FK -> mcp_server.id, ON DELETE CASCADE */
  oauth_server_id: string;
  user_id: string;
  token: JsonbColumn<OAuthToken>;
  updated_at: string;
}

/**
 * PRIMARY KEY (id) ( used for callback state.)
 */
export interface OAuthPendingAuthorizationTable {
  id: string;
  /** FK -> mcp_server.id, ON DELETE CASCADE */
  oauth_server_id: string;
  user_id: string;
  /** { mcp_server_url, code_verifier, return_to } — same writer/lifecycle, so merged into one column */
  auth_data: JsonbColumn<OAuthPendingAuthorizationData>;
  created_at: string;
}

/** Repository metadata owned by one tenant user. */
export interface RepositoryTable {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
  package_downloads_allowed: Generated<number>;
  revision: Generated<number>;
  created_at: string;
  updated_at: string;
}

/** A confirmed command is the only persisted executable authority. */
export interface RepositoryVerifyCommandTable {
  repository_id: string;
  command_id: string;
  purpose: string;
  command: string;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

/** Untrusted command suggestions awaiting explicit confirmation. */
export interface RepositoryVerifyCommandProposalTable {
  id: string;
  repository_id: string;
  purpose: string;
  command: string;
  source_kind: string;
  source_path: string;
  source_fingerprint: string;
  created_at: string;
}

/** Durable lifecycle for one registered verification command. */
export interface CommandExecutionTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  tool_name: string;
  repository_id: string;
  repository_revision: number;
  command_id: string;
  command: string;
  cwd: string;
  timeout_ms: number;
  status: string;
  disposition: string | null;
  owner_id: string;
  lease_id: string;
  lease_expires_at: string;
  started_at: string;
  completed_at: string | null;
}

export interface RepositoryWorkspaceVerificationTable {
  repository_id: string;
  workspace_cwd: string;
  mutation_epoch: number;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  observation_pending: number;
  receipt_state_sha256: string | null;
  receipt_command: string | null;
  receipt_created_at: string | null;
  receipt_result_session_id: string | null;
  receipt_result_turn_id: string | null;
  receipt_result_thread_id: string | null;
  receipt_result_tool_call_id: string | null;
  receipt_result_event_id: string | null;
}

export interface Database {
  session: SessionTable;
  session_folder: SessionFolderTable;
  space_aggregate: SpaceAggregateTable;
  space: SpaceTable;
  space_revision: SpaceRevisionTable;
  sentinel_audit: SentinelAuditTable;
  approval_token: ApprovalTokenTable;
  sentinel_user_settings: SentinelUserSettingsTable;
  implementation_plan_grant: ImplementationPlanGrantTable;
  implementation_plan_dispatch: ImplementationPlanDispatchTable;
  turn: TurnTable;
  turn_thread: TurnThreadTable;
  turn_thread_context: TurnThreadContextTable;
  session_event: SessionEventTable;
  thread_context_log: ThreadContextLogTable;
  thread_capability_state: ThreadCapabilityStateTable;
  model_provider: ModelProviderTable;
  skill: SkillTable;
  sandbox_provider: SandboxProviderTable;
  agent: AgentTable;
  schedule: ScheduleTable;
  schedule_run: ScheduleRunTable;
  personalization_profile: PersonalizationProfileTable;
  persona: PersonaTable;
  persona_name_key: PersonaNameKeyTable;
  session_persona: SessionPersonaTable;
  mcp_server: McpServerTable;
  mcp_tool_grant: McpToolGrantTable;
  google_connection: GoogleConnectionTable;
  google_oauth_pending: GoogleOAuthPendingTable;
  oauth_token: OAuthTokenTable;
  oauth_pending_authorization: OAuthPendingAuthorizationTable;
  repository: RepositoryTable;
  repository_verify_command: RepositoryVerifyCommandTable;
  repository_verify_command_proposal: RepositoryVerifyCommandProposalTable;
  command_execution: CommandExecutionTable;
  repository_workspace_verification: RepositoryWorkspaceVerificationTable;
  artifact_blob: ArtifactBlobTable;
  turn_artifact: TurnArtifactTable;
  chat_image: ChatImageTable;
  chat_image_turn_allowance: ChatImageTurnAllowanceTable;
  global_settings: GlobalSettingsTable;
  token_factory_usage: TokenFactoryUsageTable;
  token_factory_model_usage: TokenFactoryModelUsageTable;
}
