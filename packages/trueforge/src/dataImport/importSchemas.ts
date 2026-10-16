/**
 * Zod schemas for every JSON section of a data export archive.
 *
 * Import validates the whole archive against these before anything is
 * written. The schemas cover the fields import consumes; store records carry
 * their owner and tenant fields along, which import checks for shape and
 * then replaces with the importing user's identity.
 */
import {
  AgentSpecSchema,
  CreatedBySubjectSchema,
  SessionAgentSchema,
  SessionMetadataSchema,
  SessionMetricsSchema,
  SessionSourceSchema,
  TaskChecklistSchema,
  TurnInputItemSchema,
  TurnStateSchema,
} from '@truefoundry/trueforge-core/agent-session';
import { ModelMessageEventSchema, TaskStateSchema, type JsonValue } from '@truefoundry/trueforge-core/core';
import {
  AgentInfoSchema,
  AgentParentSchema,
  ContextMessageSchema,
} from '@truefoundry/trueforge-core/core/events/schema';
import { LLMToolMessageSchema } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { CurrentContextUsageSchema } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { z } from 'zod';

import { NameSchema } from '../schemas/common';
import { SessionEventWithPassthroughSchema } from '../schemas/events';
import { McpServerManifestSchema } from '../schemas/mcpServer';
import { KnowledgeDocumentStatusSchema, KnowledgeSourceKindSchema } from '../schemas/personaKnowledge';
import { ScheduleManifestSchema } from '../schemas/schedule';
import { SentinelUserSettingsSchema } from '../schemas/sentinelSettings';
import { SpaceContentSchema } from '../schemas/space';

export const ImportManifestSchema = z.object({
  format: z.string(),
  schema_version: z.number().int(),
  exported_at: z.string(),
  app_version: z.string(),
  /** The tenant the exported records were written under; memory vault names embed it. */
  tenant_id: z.string().min(1),
  include_uploads: z.boolean(),
});
export type ImportManifest = z.infer<typeof ImportManifestSchema>;

/** Every durable event shape this build can persist: built-in events plus the host's passthrough events. */
export const ImportEventSchema = SessionEventWithPassthroughSchema;
export type ImportEvent = z.infer<typeof ImportEventSchema>;

/** A stored instant; session and turn dates are written back to the store, so a bad one fails before any write. */
const ArchivedInstantSchema = z.iso.datetime({ offset: true });

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A finished subagent's marker, composed from the message schemas that own its parts. */
const ImportCompletionMarkerSchema = z.object({
  type: z.enum(['done', 'error']),
  output: ModelMessageEventSchema,
  error_message: z.string().optional(),
  send_to_parent: LLMToolMessageSchema,
});

const ImportThreadSnapshotSchema = z.looseObject({
  thread_id: z.string().min(1),
  context: z.array(ContextMessageSchema),
  current_context_usage: CurrentContextUsageSchema,
  parent: AgentParentSchema.nullable().optional(),
  agent_info: AgentInfoSchema.nullable().optional(),
  completion: ImportCompletionMarkerSchema.nullable().optional(),
  capability_state: z.record(z.string(), JsonValueSchema).nullable(),
  tool_call_memo: z.looseObject({}).optional(),
  task_state: TaskStateSchema.optional(),
});
export type ImportThreadSnapshot = z.infer<typeof ImportThreadSnapshotSchema>;

const ImportMcpServerSnapshotSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
});

export const ImportTurnRecordSchema = z.object({
  turn_id: z.string().min(1),
  session_id: z.string().min(1),
  first_turn_id: z.string(),
  ancestor_ids: z.array(z.string()),
  previous_turn_id: z.string().nullable(),
  state: TurnStateSchema,
  input: z.array(TurnInputItemSchema),
  snapshot: z.object({
    threads: z.record(z.string(), ImportThreadSnapshotSchema),
    mcp_servers: z.record(z.string(), ImportMcpServerSnapshotSchema).nullable(),
    // Sandbox handles belong to the source deployment; the export leaves them out.
    sandbox_info: z.looseObject({ sandbox_id: z.string() }).nullish(),
  }),
  custom: z.unknown(),
  created_at: ArchivedInstantSchema,
  updated_at: ArchivedInstantSchema,
});
export type ImportTurnRecord = z.infer<typeof ImportTurnRecordSchema>;

export const ImportSessionRecordSchema = z.object({
  session_id: z.string().min(1),
  tenant_id: z.string(),
  created_by_subject: CreatedBySubjectSchema,
  agent: SessionAgentSchema,
  title: z.string().nullable(),
  folder_id: z.string().nullable(),
  external_id: z.string().nullable(),
  source: SessionSourceSchema.nullable(),
  metadata: SessionMetadataSchema,
  custom: z.unknown(),
  approval_grants: z.array(z.string()),
  task_checklist: TaskChecklistSchema,
  metrics: SessionMetricsSchema,
  repository_id: z.string().nullable(),
  workspace_cwd: z.string().nullable(),
  last_turn_id: z.string().nullable(),
  created_at: ArchivedInstantSchema,
  updated_at: ArchivedInstantSchema,
  last_activity_timestamp_ms: z.number(),
});
export type ImportSessionRecord = z.infer<typeof ImportSessionRecordSchema>;

export const ImportArtifactRecordSchema = z.object({
  tenant_id: z.string(),
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  path: z.string().min(1),
  name: z.string(),
  status: z.enum(['stored', 'skipped_size', 'skipped_missing']),
  digest: z.string().nullable(),
  size: z.number().nullable(),
  mime: z.string().nullable(),
  skip_reason: z.string().nullable(),
  created_at: z.string(),
});
export type ImportArtifactRecord = z.infer<typeof ImportArtifactRecordSchema>;

export const ImportSessionEntrySchema = z.object({
  session: ImportSessionRecordSchema,
  turns: z.array(z.object({ turn: ImportTurnRecordSchema, events: z.array(ImportEventSchema) })),
  artifacts: z.array(ImportArtifactRecordSchema),
});
export type ImportSessionEntry = z.infer<typeof ImportSessionEntrySchema>;
export const ImportSessionsFileSchema = z.array(ImportSessionEntrySchema);

export const ImportFolderRecordSchema = z.object({
  tenant_id: z.string(),
  folder_id: z.string().min(1),
  created_by: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ImportFolderRecord = z.infer<typeof ImportFolderRecordSchema>;
export const ImportFoldersFileSchema = z.array(ImportFolderRecordSchema);

export const ImportAgentRecordSchema = z.object({
  id: z.string().min(1),
  name: NameSchema,
  description: z.string(),
  manifest: AgentSpecSchema,
  external_id: z.string().nullable(),
  created_by_subject: CreatedBySubjectSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ImportAgentRecord = z.infer<typeof ImportAgentRecordSchema>;
export const ImportAgentsFileSchema = z.array(ImportAgentRecordSchema);

export const ImportPersonaRecordSchema = z.object({
  tenant_id: z.string(),
  id: z.string().min(1),
  created_by: z.string(),
  display_name: z.string().min(1),
  aliases: z.array(z.string()),
  instructions: z.string(),
  model_name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  updated_by: z.string(),
});
export type ImportPersonaRecord = z.infer<typeof ImportPersonaRecordSchema>;

export const ImportKnowledgeDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  title_explicit: z.boolean(),
  source_kind: KnowledgeSourceKindSchema,
  source_label: z.string(),
  source_url: z.string().nullable(),
  status: KnowledgeDocumentStatusSchema,
  status_message: z.string().nullable(),
  chunk_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  chunks: z.array(z.object({ chunk_index: z.number().int().nonnegative(), text: z.string() })),
});
export type ImportKnowledgeDocument = z.infer<typeof ImportKnowledgeDocumentSchema>;

export const ImportPersonasFileSchema = z.array(
  z.object({
    persona: ImportPersonaRecordSchema,
    knowledge: z.object({ documents: z.array(ImportKnowledgeDocumentSchema) }),
  }),
);
export type ImportPersonasFile = z.infer<typeof ImportPersonasFileSchema>;

export const ImportPersonalizationFileSchema = z
  .object({
    tenant_id: z.string(),
    created_by: z.string(),
    revision: z.number().int(),
    digest: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    updated_by: z.string(),
    assistant_name: z.string().nullable(),
    assistant_identity: z.string().nullable(),
    voice_guidance: z.string().nullable(),
    user_profile: z.string().nullable(),
    pinned_preferences: z.array(z.string()),
    learned_profile: z.string().nullable(),
    learning_enabled: z.boolean(),
  })
  .nullable();
export type ImportPersonalizationFile = z.infer<typeof ImportPersonalizationFileSchema>;

export const ImportSpaceRecordSchema = z.object({
  tenant_id: z.string(),
  id: z.string().min(1),
  created_by: z.string(),
  ...SpaceContentSchema.shape,
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ImportSpaceRecord = z.infer<typeof ImportSpaceRecordSchema>;

export const ImportSpacesFileSchema = z.array(
  z.object({ space: ImportSpaceRecordSchema, revisions: z.array(ImportSpaceRecordSchema) }),
);
export type ImportSpacesFile = z.infer<typeof ImportSpacesFileSchema>;

export const ImportScheduleRecordSchema = z.object({
  id: z.string().min(1),
  tenant_id: z.string(),
  agent_id: z.string().min(1),
  agent_name: z.string().nullable(),
  name: z.string().min(1),
  manifest: ScheduleManifestSchema,
  status: z.enum(['active', 'paused']),
  created_by_subject: CreatedBySubjectSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ImportScheduleRecord = z.infer<typeof ImportScheduleRecordSchema>;
export const ImportSchedulesFileSchema = z.array(ImportScheduleRecordSchema);

export const ImportConnectorRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  first_party: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  manifest: McpServerManifestSchema,
});
export type ImportConnectorRecord = z.infer<typeof ImportConnectorRecordSchema>;
export const ImportConnectorsFileSchema = z.array(ImportConnectorRecordSchema);

export const ImportSettingsFileSchema = z.object({
  /** Instance-wide toggles; only present for an administrator's export. */
  instance: z.array(z.object({ key: z.string().min(1), value: z.string() })),
  permission_settings: SentinelUserSettingsSchema,
});
export type ImportSettingsFile = z.infer<typeof ImportSettingsFileSchema>;
