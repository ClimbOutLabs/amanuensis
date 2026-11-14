/**
 * Shipped mcp-catalog.yaml schemas (discovery presets). Separate from
 * configured MCP server manifests in mcpServer.ts.
 */
import { z } from '@hono/zod-openapi';
import { NameSchema, uniqueNames } from './common';
import {
  McpSearchPlumbingFieldsSchema,
  McpSearchToolsSchema,
  McpServerDescriptionSchema,
  McpServerManifestAuthSchema,
  McpServerTypeSchema,
} from './mcpServerCommon';

/**
 * Catalog presets are user-savable `remote` entries only.
 * `truefoundry` is TrueFoundry-managed.
 */
export const CatalogMcpServerTypeSchema = McpServerTypeSchema.exclude(['truefoundry']).openapi('CatalogMCPServerType');

/** Catalog entry — discovery preset the settings UI copies into a PUT body. */
export const CatalogMcpServerSchema = z
  .object({
    type: CatalogMcpServerTypeSchema,
    name: NameSchema,
    logo: z.url().optional().describe('URL of the MCP server logo asset.'),
    url: z.url().describe('URL of the remote MCP server.'),
    description: McpServerDescriptionSchema,
    auth: McpServerManifestAuthSchema.optional(),
    search_provider: z
      .boolean()
      .optional()
      .describe('When true, adding this preset offers to make it the web search provider.'),
    search_tools: McpSearchToolsSchema.optional().describe(
      'Search tools of this server that run without asking when it is the web search provider.',
    ),
    page_read_tools: McpSearchToolsSchema.optional().describe(
      'Page-read tools of this server that run without asking when it is the web search provider.',
    ),
  })
  .strict()
  .openapi('CatalogMCPServer');

/** A shipped catalog entry: the public preset plus what only the server reads. */
const CatalogPresetSchema = z
  .object({
    ...CatalogMcpServerSchema.shape,
    search_plumbing_fields: McpSearchPlumbingFieldsSchema.optional(),
    search_in_process: z
      .boolean()
      .optional()
      .describe('When true, the host serves this preset’s search itself, in process, once it is the web search provider.'),
  })
  .strict();

export const McpCatalogFileSchema = z
  .object({
    mcp_servers: z.array(CatalogPresetSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    uniqueNames(file.mcp_servers, ctx);
  });

export const GetMcpServerCatalogResponseSchema = z
  .object({
    data: z.array(CatalogMcpServerSchema),
  })
  .openapi('GetMCPServerCatalogResponse');

export type CatalogMcpServer = z.infer<typeof CatalogMcpServerSchema>;
export type CatalogPreset = z.infer<typeof CatalogPresetSchema>;
export type McpCatalogFile = z.infer<typeof McpCatalogFileSchema>;
