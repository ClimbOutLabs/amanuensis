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
import { ModelMessageEventSchema, TaskStateSchema } from '@truefoundry/trueforge-core/core';
import {
  AgentInfoSchema,
  AgentParentSchema,
  ContextMessageSchema,
} from '@truefoundry/trueforge-core/core/events/schema';
import { InternalToolCallInfoSchema, LLMToolMessageSchema } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { CurrentContextUsageSchema } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { z } from 'zod';

import { NameSchema } from '../schemas/common';
import { SessionEventWithPassthroughSchema } from '../schemas/events';
import { McpServerManifestSchema } from '../schemas/mcpServer';
import { PersonaActivationSchema, PersonaSchema, validatePersonaContentNames } from '../schemas/persona';
import { PersonaKnowledgeDocumentSchema } from '../schemas/personaKnowledge';
import { PersonalizationProfileSchema, validatePersonalizationContent } from '../schemas/personalization';
import { ScheduleManifestSchema, ScheduleStatusSchema } from '../schemas/schedule';
import { SentinelAuditRecordSchema } from '../schemas/sentinelAudit';
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

/** A finished subagent's marker, composed from the message schemas that own its parts. */
const ImportCompletionMarkerSchema = z.object({
  type: z.enum(['done', 'error']),
  output: ModelMessageEventSchema,
  error_message: z.string().optional(),
  send_to_parent: LLMToolMessageSchema,
});

/**
 * What an archived tool call may keep of its host-owned info: identity and display facts only.
 * Everything that decides whether a call needs approval, runs, or is held for the owner is
 * re-derived by the host when a call is made, never taken from an archive.
 */
const ImportToolCallInfoSchema = InternalToolCallInfoSchema.pick({
  type: true,
  mcp_server_id: true,
  mcp_server_name: true,
  original_tool_name: true,
  is_deferred: true,
  description: true,
  read_only_hint: true,
  destructive_hint: true,
  open_world_hint: true,
  effect: true,
});

const ImportContextMessageSchema = ContextMessageSchema.transform((message, ctx) => {
  if (!('tool_calls' in message) || message.tool_calls === undefined) {
    return message;
  }
  const toolCalls: typeof message.tool_calls = [];
  for (const call of message.tool_calls) {
    const toolInfo = ImportToolCallInfoSchema.safeParse(call.tool_info);
    if (!toolInfo.success) {
      ctx.addIssue({ code: 'custom', message: 'A tool call carries malformed tool info.' });
      return z.NEVER;
    }
    toolCalls.push({ ...call, tool_info: toolInfo.data });
  }
  return { ...message, tool_calls: toolCalls };
});

/** Result a call that was still open when the archive was made gets; it never ran here. */
export const EXPIRED_CALL_RESULT = 'This request expired when the chat was imported. It was not run.';

export type ImportContextMessage = z.infer<typeof ImportContextMessageSchema>;

/**
 * Keeps only conversation messages; decisions and dispatch markers are matched by call id, so an
 * archive carries none of them. Every call still open is then answered so the chat can take a new message.
 */
export function withoutArchivedAdmissions(context: readonly ImportContextMessage[]): ImportContextMessage[] {
  const kept = context.filter(message => 'role' in message);
  const answered = new Set<string>();
  for (const message of kept) {
    if ('role' in message && message.role === 'tool') {
      answered.add(message.tool_call_id);
    }
  }
  const out: ImportContextMessage[] = [];
  for (const message of kept) {
    out.push(message);
    if ('tool_calls' in message) {
      for (const call of message.tool_calls ?? []) {
        if (!answered.has(call.id)) {
          answered.add(call.id);
          out.push({ role: 'tool', tool_call_id: call.id, content: EXPIRED_CALL_RESULT });
        }
      }
    }
  }
  return out;
}

/** A subagent's checkout path belongs to the source machine. */
const ImportAgentInfoSchema = AgentInfoSchema.omit({ workspace_cwd: true });

/**
 * What a thread may bring back. Capability state and the tool-call memo are runtime bookkeeping
 * the host rebuilds as the chat continues, so an archive's copies are left out.
 */
const ImportThreadFieldsSchema = z.object({
  thread_id: z.string().min(1),
  current_context_usage: CurrentContextUsageSchema,
  parent: AgentParentSchema.nullable().optional(),
  agent_info: ImportAgentInfoSchema.nullable().optional(),
  completion: ImportCompletionMarkerSchema.nullable().optional(),
  task_state: TaskStateSchema.optional(),
});

const ImportThreadSnapshotSchema = z.object({
  ...ImportThreadFieldsSchema.shape,
  context: z.array(ImportContextMessageSchema).transform(withoutArchivedAdmissions),
});
export type ImportThreadSnapshot = z.infer<typeof ImportThreadSnapshotSchema>;

/** A thread in a sessions/ turn record: the first `context_base` messages of the previous record's copy, then `context`. */
const ImportThreadDeltaSchema = z.object({
  ...ImportThreadFieldsSchema.shape,
  context_base: z.number().int().nonnegative(),
  context: z.array(ImportContextMessageSchema),
});

const ImportTurnFieldsSchema = z.object({
  turn_id: z.string().min(1),
  session_id: z.string().min(1),
  first_turn_id: z.string(),
  ancestor_ids: z.array(z.string()),
  previous_turn_id: z.string().nullable(),
  state: TurnStateSchema,
  input: z.array(TurnInputItemSchema),
  custom: z.unknown(),
  created_at: ArchivedInstantSchema,
  updated_at: ArchivedInstantSchema,
});

export const ImportTurnRecordSchema = z.object({
  ...ImportTurnFieldsSchema.shape,
  // Server connections and sandbox handles belong to the source deployment and are never restored.
  snapshot: z.object({ threads: z.record(z.string(), ImportThreadSnapshotSchema) }),
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
  /** Where the file's bytes are in the archive; absent when they were not exported. */
  archive_entry: z.string().startsWith('files/').optional(),
});
export type ImportArtifactRecord = z.infer<typeof ImportArtifactRecordSchema>;

/** One persona choice from a chat's history; the importing owner's chat id replaces the archived one. */
const ImportPersonaActivationSchema = z.object(
  PersonaActivationSchema.omit({ session_id: true, created_at: true }).shape,
);

export const ImportSessionEntrySchema = z.object({
  session: ImportSessionRecordSchema,
  turns: z.array(z.object({ turn: ImportTurnRecordSchema, events: z.array(ImportEventSchema) })),
  artifacts: z.array(ImportArtifactRecordSchema),
  /** Absent from exports made before persona choices travelled. */
  persona_activations: z.array(ImportPersonaActivationSchema).default([]),
});
export type ImportSessionEntry = z.infer<typeof ImportSessionEntrySchema>;
/** The single sessions.json of format version 1. */
export const ImportSessionsFileSchema = z.array(ImportSessionEntrySchema);

/** A record of a sessions/ file: a chat, then each of its turns in order. */
const ImportSessionPartRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    session: ImportSessionRecordSchema,
    persona_activations: z.array(ImportPersonaActivationSchema),
  }),
  z.object({
    kind: z.literal('turn'),
    turn: z.object({
      ...ImportTurnFieldsSchema.shape,
      snapshot: z.object({ threads: z.record(z.string(), ImportThreadDeltaSchema) }),
    }),
    events: z.array(ImportEventSchema),
    artifacts: z.array(ImportArtifactRecordSchema),
  }),
]);
export type ImportSessionPartRecord = z.infer<typeof ImportSessionPartRecordSchema>;
export const ImportSessionPartFileSchema = z.array(ImportSessionPartRecordSchema);

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

/** Persona text is rendered into every prompt, so a record carries the same content checks as one typed in the app. */
export const ImportPersonaRecordSchema = z
  .object({ tenant_id: z.string(), ...PersonaSchema.shape })
  .superRefine(validatePersonaContentNames);
export type ImportPersonaRecord = z.infer<typeof ImportPersonaRecordSchema>;

export const ImportKnowledgeDocumentSchema = z.object({
  ...PersonaKnowledgeDocumentSchema.shape,
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
  .object({ tenant_id: z.string(), ...PersonalizationProfileSchema.shape })
  .superRefine(validatePersonalizationContent)
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
  status: ScheduleStatusSchema,
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

/** One permission-history row; dates are written back, so a bad one fails before any write. */
export const ImportAuditRecordSchema = z.object({
  ...SentinelAuditRecordSchema.shape,
  created_at: ArchivedInstantSchema,
});
export type ImportAuditRecord = z.infer<typeof ImportAuditRecordSchema>;
export const ImportAuditFileSchema = z.array(ImportAuditRecordSchema);
