/**
 * Configured MCP server domain + wire schemas: the `mcp_server.manifest` JSONB
 * document, admin/chat list projections, and auth_status. Catalog file schemas
 * live in mcpCatalog.ts.
 *
 * McpServerManifest is a `type`-discriminated oneOf of
 * RemoteMcpServerManifest | TrueFoundryMcpServerManifest.
 *
 * Auth: `header` stores shared request headers on the row.
 * Turn execution resolves DCR tokens via resolveMcpAuth.
 */
import { z } from '@hono/zod-openapi';
import {
  type IntegerBounds,
  MEMORY_RECALL_MIN_SCORE_LIMITS,
  MEMORY_SETTINGS_LIMITS,
  REFLECT_BUDGETS,
} from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';
import type { OAuthToken } from '../mcp/auth/types';
import { NameSchema } from './common';

const MCP_SERVER_TYPES = ['remote', 'truefoundry'] as const;

/**
 * Transport/kind of MCP server.
 * `remote` — user-configured URL (standalone / local registry).
 * `truefoundry` — TrueFoundry-managed: gateway proxy URL.
 */
export const McpServerTypeSchema = z.enum(MCP_SERVER_TYPES).openapi('MCPServerType');

export const McpServerNameParamsSchema = z
  .object({ name: z.string().min(1).describe('MCP server name.') })
  .openapi('MCPServerNameParams');

export const McpAuthorizeQuerySchema = z
  .object({
    return_to: z
      .string()
      .optional()
      .describe(
        'Optional path to return to after OAuth. Must be a same-origin relative path; the OAuth callback redirects here with `isSuccess`/`reason` appended.',
      ),
  })
  .openapi('AuthorizeMCPServerRequestQuery');

export const ListMcpServerToolsResponseSchema = z
  .object({
    // TODO: Type tools/list entries to the MCP tool shape (name, description, inputSchema, …) for OpenAPI quality.
    data: z
      .array(z.record(z.string(), z.unknown()))
      .describe('MCP `tools/list` entries, passed through verbatim from the MCP server.'),
  })
  .openapi('ListMCPServerToolsResponse');

const McpServerHeaderAuthSchema = z
  .object({
    type: z.literal('header').describe('Authenticate with static HTTP headers.'),
    headers: z
      .record(z.string().min(1), z.string().min(1))
      .refine(headers => Object.keys(headers).length > 0, {
        message: 'must include at least one header',
      })
      .describe(
        'Request headers for this MCP server. Responses are redacted; on PUT, a real value sets/rotates and a redacted value keeps the stored secret for that header name.',
      ),
  })
  .strict()
  .openapi('MCPServerHeaderAuth');

/** OAuth Dynamic Client Registration — stub until authorize/token exchange is wired. */
const McpServerDcrAuthSchema = z
  .object({
    type: z.literal('dcr').describe('Authenticate via OAuth Dynamic Client Registration.'),
  })
  .strict()
  .openapi('MCPServerDcrAuth');

const McpServerOAuthClientAuthSchema = z
  .object({
    type: z.literal('oauth_client').describe('Authenticate with a pre-registered OAuth client.'),
    client_id: z.string().min(1).describe('OAuth client ID registered with the authorization server.'),
    client_secret: z
      .string()
      .min(1)
      .describe(
        'OAuth client secret. Responses are redacted; on PUT, a real value sets/rotates and a redacted value keeps the stored secret.',
      ),
    scopes: z
      .array(z.string().min(1))
      .optional()
      .describe('OAuth scopes to request. When absent, requests the default scopes for the server.'),
  })
  .strict()
  .openapi('MCPServerOAuthClientAuth');

export const McpServerManifestAuthSchema = z
  .discriminatedUnion('type', [McpServerHeaderAuthSchema, McpServerDcrAuthSchema, McpServerOAuthClientAuthSchema])
  .describe('Optional auth settings. Omit when the server needs no credentials.')
  .openapi('MCPServerManifestAuth');

export const McpServerDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Concise summary of what this MCP server provides.');

const boundedInt = (bounds: IntegerBounds) => z.number().int().min(bounds.min).max(bounds.max).optional();
/** As {@link boundedInt}, for a fractional bound (`recall_min_score`) rather than an integer one. */
const boundedNumber = (bounds: IntegerBounds) => z.number().min(bounds.min).max(bounds.max).optional();

/**
 * Per-bank memory tuning, set in Settings > Memory. Every field is optional: one that is absent
 * keeps the server-wide `MEMORY_*` default, so an instance with no tuning behaves exactly as the
 * environment says and nothing is configured in two places at once. Bounds come from
 * trueforge-core, which the settings form also renders with.
 */
export const MemoryProviderSettingsSchema = z
  .object({
    recall_timeout_ms: boundedInt(MEMORY_SETTINGS_LIMITS.recallTimeoutMs).describe(
      'How long a turn waits for recalled memory before continuing without it. Default MEMORY_RECALL_TIMEOUT_MS.',
    ),
    recall_query_window: boundedInt(MEMORY_SETTINGS_LIMITS.recallQueryWindow).describe(
      'How many recent user messages form the recall query. Default MEMORY_RECALL_QUERY_WINDOW.',
    ),
    recall_min_score: boundedNumber(MEMORY_RECALL_MIN_SCORE_LIMITS).describe(
      'Relevance floor for a recalled item or entity summary that carries a provider score; anything ' +
        'scored lower is dropped. Ignored for a response with no scores. Default MEMORY_RECALL_MIN_SCORE.',
    ),
    recall_max_items: boundedInt(MEMORY_SETTINGS_LIMITS.recallMaxItems).describe(
      'Most recalled items kept, by provider rank, when the response carries no per-item score. ' +
        'Default MEMORY_RECALL_MAX_ITEMS.',
    ),
    recall_max_entities: boundedInt(MEMORY_SETTINGS_LIMITS.recallMaxEntities).describe(
      'Most entity summaries kept, by provider rank, when the response carries no per-entity score. ' +
        'Default MEMORY_RECALL_MAX_ENTITIES.',
    ),
    curated_enabled: z
      .boolean()
      .optional()
      .describe('Inject the bank profile and matching mental models on every turn. Default MEMORY_CURATED_ENABLED.'),
    curated_max_models: boundedInt(MEMORY_SETTINGS_LIMITS.curatedMaxModels).describe(
      'Most mental models injected on one turn. Default MEMORY_CURATED_MAX_MODELS.',
    ),
    curated_max_tokens: boundedInt(MEMORY_SETTINGS_LIMITS.curatedMaxTokens).describe(
      'Token budget for the injected mental-model lines. Default MEMORY_CURATED_MAX_TOKENS.',
    ),
    reflect_enabled: z
      .boolean()
      .optional()
      .describe('Ask the bank to reflect on synthesis-shaped asks. Default MEMORY_REFLECT_ENABLED.'),
    reflect_budget: z.enum(REFLECT_BUDGETS).optional().describe('Reflect effort. Default MEMORY_REFLECT_BUDGET.'),
    reflect_max_tokens: boundedInt(MEMORY_SETTINGS_LIMITS.reflectMaxTokens).describe(
      'Max tokens the bank may spend on a reflect answer. Default MEMORY_REFLECT_MAX_TOKENS.',
    ),
    reflect_timeout_ms: boundedInt(MEMORY_SETTINGS_LIMITS.reflectTimeoutMs).describe(
      'How long a turn waits for a reflection before continuing without it. Default MEMORY_REFLECT_TIMEOUT_MS.',
    ),
    screen_enabled: z
      .boolean()
      .optional()
      .describe(
        'Screen recalled items and entity summaries with the Prompt Guard classifier before they reach the ' +
          'model. Has no effect when no classifier service is configured (`MEMORY_SCREEN_URL`). Default MEMORY_SCREEN_ENABLED.',
      ),
  })
  .strict()
  .describe(
    'Per-bank memory tuning; each field present overrides the matching server-wide MEMORY_* setting for this provider.',
  )
  .openapi('MemoryProviderSettings');

export type MemoryProviderSettings = z.infer<typeof MemoryProviderSettingsSchema>;

/** User-configured remote MCP endpoint. */
const RemoteMcpServerManifestSchema = z
  .object({
    type: z.literal(McpServerTypeSchema.enum.remote),
    name: NameSchema,
    url: z.url().describe('MCP endpoint URL.'),
    description: McpServerDescriptionSchema,
    auth: McpServerManifestAuthSchema.optional(),
    memory_provider: z
      .boolean()
      .optional()
      .describe(
        'When true, this connector is the long-term memory provider: the host recalls from it before every model call and retains every completed turn. Its URL must be a single-bank Hindsight MCP URL.',
      ),
    memory_settings: MemoryProviderSettingsSchema.optional(),
  })
  .strict()
  .openapi('RemoteMCPServerManifest');

/** TrueFoundry-managed MCP server; `url` is the resolved AI Gateway proxy URL. */
const TrueFoundryMcpServerManifestSchema = z
  .object({
    type: z.literal(McpServerTypeSchema.enum.truefoundry),
    name: NameSchema,
    url: z.url().describe('Resolved AI Gateway proxy URL for this TrueFoundry-managed MCP server.'),
    description: McpServerDescriptionSchema,
    auth: McpServerManifestAuthSchema.optional(),
  })
  .strict()
  .openapi('TrueFoundryMCPServerManifest');

export const McpServerManifestSchema = z
  .discriminatedUnion('type', [RemoteMcpServerManifestSchema, TrueFoundryMcpServerManifestSchema])
  .openapi('MCPServerManifest');

export const McpAuthStatusSchema = z
  .object({
    status: z
      .enum(['authenticated', 'auth_required', 'not_required'])
      .describe('Current auth state for this MCP server.'),
    authorization_url: z
      .url()
      .optional()
      .describe('When auth is required, this contains the URL to redirect the user to for authorization.'),
  })
  .strict()
  .describe('Current auth state.')
  .openapi('MCPAuthStatus');

/** Admin/settings wire view: identity column plus nested manifest and auth_status. */
export const ConfiguredMcpServerSchema = z
  .object({
    name: NameSchema,
    manifest: McpServerManifestSchema,
    auth_status: McpAuthStatusSchema,
  })
  .strict()
  .openapi('ConfiguredMCPServer');

export const CreateMcpServerRequestSchema = z
  .object({
    manifest: McpServerManifestSchema,
  })
  .strict()
  .openapi('CreateMCPServerRequest');

export const UpdateMcpServerRequestSchema = z
  .object({
    manifest: McpServerManifestSchema,
  })
  .strict()
  .openapi('UpdateMCPServerRequest');

export const GetMcpServerResponseSchema = z.object({ data: ConfiguredMcpServerSchema }).openapi('GetMCPServerResponse');
export const ListMcpServersResponseSchema = z
  .object({
    data: z.array(ConfiguredMcpServerSchema),
  })
  .openapi('ListMCPServersResponse');
export const DeleteMcpServerResponseSchema = z.object({}).openapi('DeleteMCPServerResponse');

/** Public auth mechanism for chat/composer (no secrets). */
export const McpServerAuthPublicSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('dcr') }).strict(),
    z.object({ type: z.literal('header') }).strict(),
    z.object({ type: z.literal('oauth_client') }).strict(),
  ])
  .describe('Auth mechanism when configured (no secrets). Omit when the server needs no credentials.')
  .openapi('MCPServerAuthPublic');

/** Chat/composer read view — public fields plus per-user auth_status. */
export const AvailableMcpServerSchema = z
  .object({
    name: NameSchema,
    url: z.url().describe('URL of the remote MCP server.'),
    auth: McpServerAuthPublicSchema.optional(),
    auth_status: McpAuthStatusSchema,
  })
  .strict()
  .openapi('AvailableMCPServer');

export const ListAvailableMcpServersResponseSchema = z
  .object({
    data: z.array(AvailableMcpServerSchema),
  })
  .openapi('ListAvailableMCPServersResponse');

export const GetAvailableMcpServerResponseSchema = z
  .object({ data: AvailableMcpServerSchema })
  .openapi('GetAvailableMCPServerResponse');

export type McpServerType = z.infer<typeof McpServerTypeSchema>;
export type McpServerManifestAuth = z.infer<typeof McpServerManifestAuthSchema>;
export type RemoteMcpServerManifest = z.infer<typeof RemoteMcpServerManifestSchema>;
export type TrueFoundryMcpServerManifest = z.infer<typeof TrueFoundryMcpServerManifestSchema>;
export type McpServerManifest = z.infer<typeof McpServerManifestSchema>;
export type McpAuthStatus = z.infer<typeof McpAuthStatusSchema>;
export type McpServerAuthPublic = z.infer<typeof McpServerAuthPublicSchema>;
export type ConfiguredMcpServer = z.infer<typeof ConfiguredMcpServerSchema>;
export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequestSchema>;
export type UpdateMcpServerRequest = z.infer<typeof UpdateMcpServerRequestSchema>;
export type AvailableMcpServer = z.infer<typeof AvailableMcpServerSchema>;

/**
 * Headers for live MCP calls against a configured server.
 * Only `auth.type === 'header'` contributes. Turn execution uses DCR via
 * resolveMcpAuth instead of this helper.
 */
export function resolveConfiguredMcpRequestHeaders(manifest: McpServerManifest): Record<string, string> {
  if (manifest.auth?.type === 'header') {
    return { ...manifest.auth.headers };
  }
  return {};
}

export function resolveMcpAuthStatus({
  manifest,
  token,
}: {
  manifest: McpServerManifest;
  token?: OAuthToken;
}): McpAuthStatus {
  // TrueFoundry list responses treat this as authenticated until live per-item status is requested.
  if (manifest.type === 'truefoundry') {
    return { status: 'authenticated' };
  }
  if (manifest.auth?.type === 'dcr' || manifest.auth?.type === 'oauth_client') {
    return token ? { status: 'authenticated' } : { status: 'auth_required' };
  }
  if (manifest.auth?.type === 'header') {
    return { status: 'authenticated' };
  }
  return { status: 'not_required' };
}
