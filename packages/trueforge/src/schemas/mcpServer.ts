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
import type { OAuthToken } from '../mcp/auth/types';
import { NameSchema } from './common';
import {
  McpDeclaredChangeToolsSchema,
  McpSearchPlumbingFieldsSchema,
  McpSearchToolsSchema,
  McpServerDescriptionSchema,
  McpServerManifestAuthSchema,
  McpServerTypeSchema,
} from './mcpServerCommon';

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

/** User-configured remote MCP endpoint. */
const RemoteMcpServerManifestSchema = z
  .object({
    type: z.literal(McpServerTypeSchema.enum.remote),
    name: NameSchema,
    url: z.url().describe('MCP endpoint URL.'),
    description: McpServerDescriptionSchema,
    auth: McpServerManifestAuthSchema.optional(),
    search_provider: z
      .boolean()
      .optional()
      .describe(
        'When true, this connector is the web search provider: its read-only tools run without asking, behind an outbound secret check, unless the user switched searches to Ask. At most one connector holds it.',
      ),
    search_tools: McpSearchToolsSchema.optional().describe(
      'The search tools of the web search provider, captured from the server’s own tool list when the person designated it. Their results are recorded as search hits. Set by the server; a value sent is replaced.',
    ),
    page_read_tools: McpSearchToolsSchema.optional().describe(
      'The page-read tools of the web search provider, captured from the server’s own tool list when the person designated it. What they return is recorded as page text. Set by the server; a value sent is replaced.',
    ),
    search_plumbing_fields: McpSearchPlumbingFieldsSchema.optional().describe(
      'Argument names that are the search provider’s own bookkeeping, not the person’s text. Set by the server; a value sent is replaced.',
    ),
    search_in_process: z
      .boolean()
      .optional()
      .describe(
        'When true, the host serves this connector’s search itself, in process. Set by the server when the person designates the provider the host serves that way; a value sent is replaced.',
      ),
    declared_change_tools: McpDeclaredChangeToolsSchema.optional().describe(
      'Bare names of the tools this server itself declared as changing things, captured from its own tool list at connect time. Standing grants may cover only these. Set by the server; a value sent is replaced.',
    ),
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
    search_provider: z
      .boolean()
      .optional()
      .describe('True for the connector chosen for web search. Every chat uses it unless the person turns it off.'),
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

export const McpToolGrantParamsSchema = z
  .object({
    name: z.string().min(1).describe('MCP server name.'),
    tool_name: z.string().min(1).describe('Tool name on the MCP server.'),
  })
  .openapi('MCPToolGrantParams');

/** One tool the caller always allows on an MCP server. */
export const McpToolGrantSchema = z
  .object({
    tool_name: z.string().describe('Tool name on the MCP server.'),
    created_at: z.string().describe('When the caller chose Always allow, as an ISO 8601 UTC instant.'),
  })
  .strict()
  .openapi('MCPToolGrant');

export const ListMcpToolGrantsResponseSchema = z
  .object({
    data: z.array(McpToolGrantSchema).describe('Tools the caller always allows on this MCP server, oldest first.'),
  })
  .openapi('ListMCPToolGrantsResponse');

export const DeleteMcpToolGrantResponseSchema = z.object({}).openapi('DeleteMCPToolGrantResponse');

export type RemoteMcpServerManifest = z.infer<typeof RemoteMcpServerManifestSchema>;
export type TrueFoundryMcpServerManifest = z.infer<typeof TrueFoundryMcpServerManifestSchema>;
export type McpServerManifest = z.infer<typeof McpServerManifestSchema>;
export type McpAuthStatus = z.infer<typeof McpAuthStatusSchema>;
export type McpServerAuthPublic = z.infer<typeof McpServerAuthPublicSchema>;
export type ConfiguredMcpServer = z.infer<typeof ConfiguredMcpServerSchema>;
export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequestSchema>;
export type UpdateMcpServerRequest = z.infer<typeof UpdateMcpServerRequestSchema>;
export type AvailableMcpServer = z.infer<typeof AvailableMcpServerSchema>;
export type McpToolGrant = z.infer<typeof McpToolGrantSchema>;

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
