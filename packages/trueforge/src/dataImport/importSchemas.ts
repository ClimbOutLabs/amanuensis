/**
 * Zod schemas for every JSON section of a data export archive.
 *
 * Import validates the whole archive against these before anything is
 * written. The schemas cover the fields import consumes; store records carry
 * their owner and tenant fields along, which import checks for shape and
 * then replaces with the importing user's identity.
 *
 * What people see and own is read strictly: chats and their dates, message
 * roles and text, tool call ids, names, arguments and results, the turn
 * events a chat is drawn from (VISIBLE_EVENT_TYPES) and a finished turn's
 * output, the agent a chat runs, uploaded files and their digests, memories,
 * spaces, personas, schedules, connectors, audit rows, and the ids that tie
 * them together. Aman's own bookkeeping is read through lenient.ts, so a
 * change to it in any version never stops an import: tool call enrichment
 * (even inside visible events), telemetry and lifecycle events, other turn
 * states, metrics, thread runtime state, and settings import never applies.
 */
import {
  AgentSpecSchema,
  CreatedBySubjectSchema,
  EventType,
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

import { parseTurnCustom } from '../db/sessionCustom';
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
import {
  forwardIssues,
  internal,
  isRecord,
  mixedList,
  noteLeftOut,
  readInternal,
  readVisible,
  visible,
} from './lenient';

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

/** What the person is told was left out, in the singular; LEFT_OUT_PLURALS has each plural. */
export const LEFT_OUT = {
  toolDetail: 'tool detail',
  turnEvent: 'background note',
  turnState: 'reply status',
  turnDetail: 'reply detail',
  threadDetail: 'assistant detail',
  chatDetail: 'chat detail',
  checklistDetail: 'checklist detail',
  permissionSetting: 'permission setting',
} as const;

export const LEFT_OUT_PLURALS: Readonly<Record<string, string>> = {
  [LEFT_OUT.toolDetail]: 'tool details',
  [LEFT_OUT.turnEvent]: 'background notes',
  [LEFT_OUT.turnState]: 'reply statuses',
  [LEFT_OUT.turnDetail]: 'reply details',
  [LEFT_OUT.threadDetail]: 'assistant details',
  [LEFT_OUT.chatDetail]: 'chat details',
  [LEFT_OUT.checklistDetail]: 'checklist details',
  [LEFT_OUT.permissionSetting]: 'permission settings',
};

/** Host-owned turn data; one this version does not store is left out. */
function readTurnCustom(value: unknown): ReturnType<typeof parseTurnCustom> {
  try {
    return parseTurnCustom(value ?? null);
  } catch {
    noteLeftOut({ label: LEFT_OUT.turnDetail });
    return null;
  }
}

/** The events the chat on screen is drawn from; every other event is Aman's own record of the turn. */
const VISIBLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  EventType.TURN_CREATED,
  EventType.MODEL_MESSAGE,
  EventType.TOOL_RESPONSE,
  EventType.TOOL_RESPONSE_V2,
  EventType.TOOL_APPROVAL_REQUIRED,
  EventType.TOOL_RESPONSE_REQUIRED,
  EventType.MCP_AUTH_REQUIRED,
  EventType.TURN_DONE,
  EventType.THREAD_CREATED,
  EventType.THREAD_DONE,
]);

/** A tool call's own name and server, and the tool info it carries; see forEachToolCall. */
export interface ArchivedToolCall {
  toolName: string;
  serverName: string;
  toolInfo: Record<string, unknown>;
}

/** Visits every tool call (an object with a function name and tool info) anywhere inside `value`. */
export function forEachToolCall(value: unknown, visit: (call: ArchivedToolCall) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      forEachToolCall(item, visit);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const toolInfo = value['tool_info'];
  const fn = value['function'];
  if (isRecord(toolInfo) && isRecord(fn) && typeof fn['name'] === 'string') {
    const serverName = toolInfo['mcp_server_name'];
    visit({ toolName: fn['name'], serverName: typeof serverName === 'string' ? serverName : '', toolInfo });
  }
  for (const entry of Object.values(value)) {
    forEachToolCall(entry, visit);
  }
}

const TOOL_TYPES = InternalToolCallInfoSchema.shape.type.options;
export type ToolType = (typeof TOOL_TYPES)[number];

export function isToolType(value: unknown): value is ToolType {
  return TOOL_TYPES.some(type => type === value);
}

/** Says which kind of tool a call used, from what this Aman knows; undefined when it cannot tell. */
export type ToolTypeResolver = (call: Pick<ArchivedToolCall, 'toolName' | 'serverName'>) => ToolType | undefined;

/** A tool call whose kind neither its archive nor this Aman can tell. */
export class UnknownToolTypeError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(`The kind of the tool ${toolName} is not one this version knows.`);
    this.name = 'UnknownToolTypeError';
    this.toolName = toolName;
  }
}

let toolTypeResolver: ToolTypeResolver | undefined;

/** Runs a synchronous parse with `resolver` telling the kind of tool calls recorded with one this version does not know. */
export function withToolTypeResolver<T>(resolver: ToolTypeResolver, run: () => T): T {
  const outer = toolTypeResolver;
  toolTypeResolver = resolver;
  try {
    return run();
  } finally {
    toolTypeResolver = outer;
  }
}

/** Fills in the kind of each tool call recorded with one this version does not know, or throws. */
function withKnownToolTypes(value: unknown): unknown {
  forEachToolCall(value, ({ toolName, serverName, toolInfo }) => {
    if (isToolType(toolInfo['type'])) {
      return;
    }
    const resolved = toolTypeResolver?.({ toolName, serverName });
    if (resolved === undefined) {
      throw new UnknownToolTypeError(toolName);
    }
    // The archive is parsed from a fresh JSON copy, so filling the value in place changes nothing else.
    toolInfo['type'] = resolved;
    noteLeftOut({ label: LEFT_OUT.toolDetail });
  });
  return value;
}

const ImportEventListSchema = z.preprocess(
  withKnownToolTypes,
  mixedList({
    schema: ImportEventSchema,
    label: LEFT_OUT.turnEvent,
    visibleLabel: LEFT_OUT.toolDetail,
    isVisible: event => isRecord(event) && typeof event['type'] === 'string' && VISIBLE_EVENT_TYPES.has(event['type']),
  }),
);

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

/** A message is what people see; only each tool call's host-owned info is read leniently. */
const ImportContextMessageSchema = z
  .preprocess(withKnownToolTypes, visible(ContextMessageSchema, { label: LEFT_OUT.toolDetail }))
  .transform((message, ctx) => {
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
  current_context_usage: internal(CurrentContextUsageSchema, { label: LEFT_OUT.threadDetail }),
  parent: internal(AgentParentSchema.nullable(), {
    label: LEFT_OUT.threadDetail,
    fallback: null,
    fill: false,
  }).optional(),
  agent_info: internal(ImportAgentInfoSchema.nullable(), {
    label: LEFT_OUT.threadDetail,
    fallback: null,
    fill: false,
  }).optional(),
  completion: internal(ImportCompletionMarkerSchema.nullable(), {
    label: LEFT_OUT.threadDetail,
    fallback: null,
    fill: false,
  }).optional(),
  task_state: internal(TaskStateSchema.optional(), { label: LEFT_OUT.threadDetail }).optional(),
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
  state: z.unknown().transform((value, ctx) => {
    // A finished or failed turn's output is what people read, so it stays strict.
    const parsed =
      isRecord(value) && (value['status'] === 'done' || value['status'] === 'error')
        ? readVisible(TurnStateSchema, value, { label: LEFT_OUT.toolDetail })
        : // Any other state this version cannot read lands like a turn left running: cancelled, with nothing lost.
          TurnStateSchema.safeParse(
            readInternal(TurnStateSchema, value, { label: LEFT_OUT.turnState, fallback: { status: 'running' } }),
          );
    if (!parsed.success) {
      forwardIssues(ctx, { issues: parsed.error.issues, path: [] });
      return z.NEVER;
    }
    return parsed.data;
  }),
  input: z.array(TurnInputItemSchema),
  custom: z.unknown().transform(readTurnCustom),
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
  source: internal(SessionSourceSchema.nullable(), { label: LEFT_OUT.chatDetail }),
  metadata: internal(SessionMetadataSchema, { label: LEFT_OUT.chatDetail }),
  // Never stored on import, so data in it is left out.
  custom: z.unknown().transform(value => {
    if (isRecord(value) ? Object.keys(value).length > 0 : value !== null && value !== undefined) {
      noteLeftOut({ label: LEFT_OUT.chatDetail });
    }
    return null;
  }),
  task_checklist: internal(TaskChecklistSchema, { label: LEFT_OUT.checklistDetail }),
  metrics: internal(SessionMetricsSchema, { label: LEFT_OUT.chatDetail }),
  repository_id: internal(z.string().nullable(), { label: LEFT_OUT.chatDetail }),
  workspace_cwd: internal(z.string().nullable(), { label: LEFT_OUT.chatDetail }),
  last_turn_id: z.string().nullable(),
  created_at: ArchivedInstantSchema,
  updated_at: ArchivedInstantSchema,
  last_activity_timestamp_ms: internal(z.number(), { label: LEFT_OUT.chatDetail }),
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
  turns: z.array(z.object({ turn: ImportTurnRecordSchema, events: ImportEventListSchema })),
  artifacts: z.array(ImportArtifactRecordSchema),
  /** Absent from exports made before persona choices travelled. */
  persona_activations: z.array(ImportPersonaActivationSchema).default([]),
});
export type ImportSessionEntry = z.infer<typeof ImportSessionEntrySchema>;

/** A record of a sessions/ file: a chat, then each of its turns in order. */
export const ImportSessionPartRecordSchema = z.discriminatedUnion('kind', [
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
    events: ImportEventListSchema,
    artifacts: z.array(ImportArtifactRecordSchema),
  }),
]);
export type ImportSessionPartRecord = z.infer<typeof ImportSessionPartRecordSchema>;

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
  /** Absent from exports made before host-made schedule agents were marked. */
  host_managed: z.boolean().default(false),
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
  /** Absent from exports made before schedules kept a persona. */
  persona_id: z.string().min(1).nullable().default(null),
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
  // Never applied on import.
  permission_settings: internal(SentinelUserSettingsSchema, { label: LEFT_OUT.permissionSetting }),
});
export type ImportSettingsFile = z.infer<typeof ImportSettingsFileSchema>;

/** One permission-history row; dates are written back, so a bad one fails before any write. */
export const ImportAuditRecordSchema = z.object({
  ...SentinelAuditRecordSchema.shape,
  created_at: ArchivedInstantSchema,
});
export type ImportAuditRecord = z.infer<typeof ImportAuditRecordSchema>;
export const ImportAuditFileSchema = z.array(ImportAuditRecordSchema);
