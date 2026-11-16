/**
 * The MCP server manifest pieces the shipped catalog schemas in mcpCatalog.ts share with
 * the configured-server schemas in mcpServer.ts: server type, manifest auth, description
 * and search tools. They live apart from mcpServer.ts so loading the catalog does not pull
 * in that file's server-only imports. The database migrations bundled into the installable
 * package load the catalog at startup and can only use what that package provides.
 */
import { z } from '@hono/zod-openapi';

const MCP_SERVER_TYPES = ['remote', 'truefoundry'] as const;

/**
 * Transport/kind of MCP server.
 * `remote` — user-configured URL (standalone / local registry).
 * `truefoundry` — TrueFoundry-managed: gateway proxy URL.
 */
export const McpServerTypeSchema = z.enum(MCP_SERVER_TYPES).openapi('MCPServerType');

export type McpServerType = z.infer<typeof McpServerTypeSchema>;

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

export type McpServerManifestAuth = z.infer<typeof McpServerManifestAuthSchema>;

/** Names of the tools of a web search provider that may run without asking. */
export const McpSearchToolsSchema = z.array(z.string().min(1).max(128)).max(16);

/** Bare names of the tools a server itself declared at connect time as changing things. */
export const McpDeclaredChangeToolsSchema = z.array(z.string().min(1).max(128)).max(64);

/** Argument names of a search provider's tools that carry its own bookkeeping, not the user's text. */
export const McpSearchPlumbingFieldsSchema = z.array(z.string().min(1).max(128)).max(16);
