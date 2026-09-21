import { z } from '@hono/zod-openapi';
import { REFLECT_BUDGETS } from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

const SandboxCapabilitySchema = z
  .object({
    enabled: z.boolean().describe('Whether a sandbox provider is configured for this tenant.'),
  })
  .openapi('SandboxCapability');

const SkillCapabilitySchema = z
  .object({
    enabled: z
      .boolean()
      .describe('Whether skills are available. False when sandbox is not enabled (skills require a sandbox).'),
    reason: z.string().optional().describe('Present when skills are disabled. Explains why.'),
  })
  .openapi('SkillCapability');

const SettingsCapabilitySchema = z
  .object({
    enabled: z.boolean().describe('Whether the settings UI/API is enabled.'),
  })
  .openapi('SettingsCapability');

/**
 * Read-only status of the memory recall screen. The screen is a separate subsystem from the
 * memory provider: it classifies recalled memory as it would be injected into the model's
 * context. The classifier sidecar's URL and token are operator-configured via `MEMORY_SCREEN_*`
 * environment variables; whether screening actually runs is a per-bank user setting
 * (`screen_enabled` in Settings > Memory), which defaults to `MEMORY_SCREEN_ENABLED` when unset.
 * `enabled` here is the effective state after applying both.
 *
 * Deliberately non-sensitive: `enabled`, `configured` and `threshold` is all the Settings status
 * card needs. The classifier `MEMORY_SCREEN_URL` is never returned — it names internal
 * infrastructure and can carry userinfo — and neither is `MEMORY_SCREEN_AUTH_TOKEN`. Both stay
 * server-side.
 */
export const MemoryScreenCapabilitySchema = z
  .object({
    enabled: z.boolean().describe('Whether the memory recall screen is actually running for this bank.'),
    configured: z
      .boolean()
      .describe('Whether a screening service is configured (`MEMORY_SCREEN_URL` set), independent of the setting.'),
    reason: z.string().optional().describe('Present when the Settings switch cannot be turned on. Explains why.'),
    threshold: z
      .number()
      .optional()
      .describe('Score at or above which a recalled item is treated as malicious (`MEMORY_SCREEN_THRESHOLD`).'),
  })
  .openapi('MemoryScreenCapability');

/**
 * Read-only status of the live tool-output screen (`TOOL_OUTPUT_SCREEN_*`). This uses the same
 * classifier endpoint and threshold as the memory recall screen, but protects a different boundary:
 * structurally open-world tool results before those results are appended to model context.
 *
 * Deliberately non-sensitive for the same reason as `memory_screen`: no classifier URL and no
 * bearer token leave the server. `configured`/`reason` mirror the recall screen so Settings
 * can disable the switch when no screening service is deployed.
 */
export const ToolOutputScreenCapabilitySchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'The effective runtime state: live tool-output screening runs only when the stored setting (persisted override when set, else `TOOL_OUTPUT_SCREEN_ENABLED`) says on AND a screening service is configured — `false` whenever `MEMORY_SCREEN_URL` is unset, regardless of the stored override.',
      ),
    configured: z
      .boolean()
      .describe('Whether a screening service is configured (`MEMORY_SCREEN_URL` set), independent of the setting.'),
    reason: z.string().optional().describe('Present when the Settings switch cannot be turned on. Explains why.'),
    threshold: z
      .number()
      .optional()
      .describe('Score at or above which a tool result is treated as malicious (`MEMORY_SCREEN_THRESHOLD`).'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum classifier call time for one tool result (`TOOL_OUTPUT_SCREEN_TIMEOUT_MS`).'),
  })
  .openapi('ToolOutputScreenCapability');

/**
 * The server-wide memory defaults (`MEMORY_*`) as the process resolved them, so Settings > Memory
 * can show the real value a blank field falls back to instead of the words "server default".
 * Tuning numbers plus the backend type; nothing here names infrastructure or carries a credential.
 */
const MemoryDefaultsCapabilitySchema = z
  .object({
    backend: z.enum(['markdown', 'hindsight']).describe('`MEMORY_BACKEND` as resolved.'),
    recall_timeout_ms: z.number().int().describe('`MEMORY_RECALL_TIMEOUT_MS` as resolved.'),
    recall_query_window: z.number().int().describe('`MEMORY_RECALL_QUERY_WINDOW` as resolved.'),
    recall_min_score: z.number().describe('`MEMORY_RECALL_MIN_SCORE` as resolved.'),
    recall_max_items: z.number().int().describe('`MEMORY_RECALL_MAX_ITEMS` as resolved.'),
    recall_max_entities: z.number().int().describe('`MEMORY_RECALL_MAX_ENTITIES` as resolved.'),
    prerecall_gate_enabled: z.boolean().describe('`MEMORY_PRERECALL_GATE_ENABLED` as resolved.'),
    curated_enabled: z.boolean().describe('`MEMORY_CURATED_ENABLED` as resolved.'),
    curated_max_models: z.number().int().describe('`MEMORY_CURATED_MAX_MODELS` as resolved.'),
    curated_max_tokens: z.number().int().describe('`MEMORY_CURATED_MAX_TOKENS` as resolved.'),
    reflect_enabled: z.boolean().describe('`MEMORY_REFLECT_ENABLED` as resolved.'),
    reflect_budget: z.enum(REFLECT_BUDGETS).describe('`MEMORY_REFLECT_BUDGET` as resolved.'),
    reflect_max_tokens: z.number().int().describe('`MEMORY_REFLECT_MAX_TOKENS` as resolved.'),
    reflect_timeout_ms: z.number().int().describe('`MEMORY_REFLECT_TIMEOUT_MS` as resolved.'),
  })
  .openapi('MemoryDefaultsCapability');

export type MemoryDefaultsCapability = z.infer<typeof MemoryDefaultsCapabilitySchema>;

/**
 * Live meaning-based (embedding) recall status for the calling tenant. `enabled`
 * is the resolved `MEMORY_EMBEDDINGS_ENABLED`; `state`/`detail` come from the
 * embedding subsystem without starting any download or I/O, so this stays safe
 * on the read-mostly capabilities route. Nothing here carries memory text or
 * credentials — `detail` is a static template with counts.
 */
export const MemoryEmbeddingsCapabilitySchema = z
  .object({
    enabled: z.boolean().describe('`MEMORY_EMBEDDINGS_ENABLED` as resolved.'),
    state: z
      .enum(['starting', 'downloading', 'backfilling', 'ready', 'unavailable'])
      .describe('Meaning-based recall status for this tenant.'),
    detail: z.string().describe('Plain-English status line for Settings > Memory.'),
    indexed_entries: z.number().int().describe('Memories with cached vectors for this tenant.'),
  })
  .openapi('MemoryEmbeddingsCapability');

export type MemoryEmbeddingsCapability = z.infer<typeof MemoryEmbeddingsCapabilitySchema>;

export const BuildIdentitySchema = z
  .object({
    version: z.string().describe('Package version of the running server.'),
    ref: z
      .string()
      .optional()
      .describe(
        'Source reference the running build was stamped with, such as a commit SHA or a tag. ' +
          'Absent when the build carried no stamp.',
      ),
  })
  .openapi('BuildIdentity');

export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;

const CapabilitiesDataSchema = z
  .object({
    sandbox: SandboxCapabilitySchema,
    skill: SkillCapabilitySchema,
    settings: SettingsCapabilitySchema,
    memory_screen: MemoryScreenCapabilitySchema,
    tool_output_screen: ToolOutputScreenCapabilitySchema.optional(),
    memory_defaults: MemoryDefaultsCapabilitySchema,
    memory_embeddings: MemoryEmbeddingsCapabilitySchema,
    build: BuildIdentitySchema,
  })
  .openapi('CapabilitiesData');

export const GetCapabilitiesResponseSchema = z
  .object({
    data: CapabilitiesDataSchema,
  })
  .openapi('GetCapabilitiesResponse');
