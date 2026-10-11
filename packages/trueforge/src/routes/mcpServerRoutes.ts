/**
 * DB-backed MCP server route definitions.
 * Admin routes mount at /api/v1/settings/mcp-servers; the chat list,
 * tools, and authorize routes mount at /api/v1/mcp-servers.
 */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateMcpServerRequestSchema,
  DeleteMcpServerResponseSchema,
  DeleteMcpToolGrantResponseSchema,
  GetAvailableMcpServerResponseSchema,
  GetMcpServerResponseSchema,
  ListAvailableMcpServersResponseSchema,
  ListMcpServersResponseSchema,
  ListMcpServerToolsResponseSchema,
  ListMcpToolGrantsResponseSchema,
  McpAuthorizeQuerySchema,
  McpAuthStatusSchema,
  McpServerNameParamsSchema,
  McpToolGrantParamsSchema,
  UpdateMcpServerRequestSchema,
} from '../schemas/mcpServer';
import { MemoryProviderCheckResponseSchema } from '../schemas/memoryProvider';
import { OpenApiTag } from './openapiTags';

/** Chat/composer MCP list (not under settings). */
export const listAvailableMcpServersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'List MCP servers for chat',
  description: 'Configured MCP servers as a slim name/url list for the composer.',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListAvailableMcpServersResponseSchema } },
      description: 'MCP servers attachable to a chat (chat projection). Excludes the memory provider.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});

/** Chat/composer single-server read (not under settings). */
export const getAvailableMcpServerRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Get an MCP server for chat',
  description: 'A single MCP server as the slim chat projection, with live per-user auth_status.',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'get',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetAvailableMcpServerResponseSchema } },
      description: 'The MCP server (chat projection).',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const listMcpServersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'List MCP servers',
  description: 'Configured MCP servers with auth_status. Header secrets are redacted.',
  'x-fern-sdk-group-name': ['settings', 'mcpServers'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListMcpServersResponseSchema } },
      description: 'All configured MCP servers',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the caller is authenticated but not an admin.',
    },
  },
});

export const getMcpServerRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Get a single MCP server by name',
  description:
    'A single MCP server by name, with nested live auth_status (settings / admin projection). Header auth values are redacted.',
  'x-fern-sdk-group-name': ['settings', 'mcpServers'],
  'x-fern-sdk-method-name': 'get',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMcpServerResponseSchema } },
      description: 'The MCP server',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const createMcpServerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Create an MCP server',
  description:
    'Creates an MCP server by `name`. Fails if `name` is already taken. Runs DCR registration when `auth.type` is `dcr`. ' +
    'Header secrets: real value required; redacted with no stored value returns 400.',
  'x-fern-sdk-group-name': ['settings', 'mcpServers'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateMcpServerRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetMcpServerResponseSchema } },
      description: 'The created MCP server with auth_status',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or redacted header secret with no stored value to keep.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'An MCP server with this name already exists, or `manifest.memory_provider: true` is set while another server already holds it.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The server cannot satisfy `auth.type: dcr` (e.g. it advertises no registration_endpoint), or ' +
        '`manifest.memory_provider: true` is set and the memory-provider connection check failed. The message ' +
        'carries the upstream reason.',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported operation because the MCP servers are managed by external system',
    },
  },
});

export const putMcpServerRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Create or replace an MCP server',
  description:
    'Create or replace by `name`. Header secrets: real value sets/rotates; redacted keeps existing (400 if none).',
  'x-fern-sdk-group-name': ['settings', 'mcpServers'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMcpServerRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMcpServerResponseSchema } },
      description: 'The saved MCP server with auth_status',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or redacted header secret with no stored value to keep.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        '`manifest.memory_provider: true` is set while another server already holds it, or the connector changed ' +
        'while its memory-provider connection check was running, so the save must be retried.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The server cannot satisfy `auth.type: dcr` (e.g. it advertises no registration_endpoint), or ' +
        '`manifest.memory_provider: true` is set and the memory-provider connection check failed. The message ' +
        'carries the upstream reason.',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported operation because the MCP servers are managed by external system',
    },
  },
});

export const deleteMcpServerRoute = createRoute({
  method: 'delete',
  path: '/{name}',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Delete an MCP server',
  description:
    'Deletes an MCP server by `name`, clearing any stored OAuth authorization for it first. ' +
    'A session whose agent spec still names this server hits the existing unregistered-server error on next use.',
  'x-fern-sdk-group-name': ['settings', 'mcpServers'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteMcpServerResponseSchema } },
      description: 'MCP server deleted.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const listMcpServerToolsRoute = createRoute({
  method: 'get',
  path: '/{name}/tools',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'List tools of an MCP server',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'list_tools',
  description: 'All tools exposed by the given MCP server (non-paginated), as returned by the MCP `tools/list` call.',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListMcpServerToolsResponseSchema } },
      description: 'All tools of the MCP server.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The MCP server requires authentication (does not trigger browser OIDC login).',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The MCP server could not be reached or returned an error.',
    },
  },
});

export const listMcpToolGrantsRoute = createRoute({
  method: 'get',
  path: '/{name}/tool-grants',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'List always-allowed tools of an MCP server',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'list_tool_grants',
  description:
    'Tools on this MCP server the caller chose Always allow for. Their calls run without an approval prompt ' +
    'unless a safety rule asks again.',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListMcpToolGrantsResponseSchema } },
      description: "The caller's always-allowed tools on this MCP server.",
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const deleteMcpToolGrantRoute = createRoute({
  method: 'delete',
  path: '/{name}/tool-grants/{tool_name}',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Stop always allowing a tool of an MCP server',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'delete_tool_grant',
  description:
    "Revokes the caller's Always allow for one tool, so its next call asks for approval again. " +
    'A no-op when the tool is not always allowed.',
  request: {
    params: McpToolGrantParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteMcpToolGrantResponseSchema } },
      description: 'The tool is no longer always allowed.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const memoryCheckMcpServerRoute = createRoute({
  method: 'post',
  path: '/{name}/memory-check',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Check an MCP server as a memory provider',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'memory_check',
  description:
    'Runs one live recall against the Hindsight REST API behind this connector, the surface host-enforced memory ' +
    'actually calls. That is not the MCP endpoint `auth_status` reflects, and it may validate a different credential. ' +
    'Read-only: the connector is never modified, and a failed check is a 200 carrying the reason. The same check ' +
    'runs on every create or replace that sets `manifest.memory_provider: true`.',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: MemoryProviderCheckResponseSchema } },
      description: 'The check ran; the result says whether the provider answered and why not.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});

export const authorizeMcpServerRoute = createRoute({
  method: 'get',
  path: '/{name}/authorize',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Start (or short-circuit) the auth flow for an MCP server',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'authorize',
  description:
    'Returns current auth status. When OAuth is required, includes an authorization URL. Optional return_to is the post-consent landing path.',
  request: {
    params: McpServerNameParamsSchema,
    query: McpAuthorizeQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: McpAuthStatusSchema } },
      description: 'Either already authenticated, or an authorization URL to redirect to.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid return_to.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'DCR could not be completed for this server (e.g. it lacks a registration_endpoint).',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The authorization server failed dynamic client registration or authorization startup.',
    },
    500: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Server misconfiguration (e.g. PUBLIC_BASE_URL unset).',
    },
  },
});

export const deleteAuthorizationMcpServerRoute = createRoute({
  method: 'delete',
  path: '/{name}/authorize',
  tags: [OpenApiTag.MCP_SERVERS],
  summary: 'Disconnect OAuth for an MCP server',
  'x-fern-sdk-group-name': ['mcpServers'],
  'x-fern-sdk-method-name': 'delete_authorization',
  description:
    'Disconnects OAuth for the MCP server when applicable and returns the updated server with auth_status. ' +
    'No-op when the server does not use stored OAuth tokens.',
  request: {
    params: McpServerNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMcpServerResponseSchema } },
      description: 'The MCP server after disconnect.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'MCP server not found.',
    },
  },
});
