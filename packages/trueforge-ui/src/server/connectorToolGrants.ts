/**
 * The caller's "Always allow this tool" grants, which the Harness adds on top of the runtime's
 * connector port so Settings can show and revoke them.
 *
 * The server owns the wire shape (`ListMcpToolGrantsResponseSchema` in the Harness's
 * `schemas/mcpServer.ts`); this module is its single owner on the client. It collapses into the
 * generated SDK once that carries `/mcp-servers/{name}/tool-grants`.
 */
import { z } from 'zod';

const ToolGrantsResponseSchema = z.object({
  data: z.array(z.object({ tool_name: z.string(), created_at: z.string() })),
});

export interface ConnectorToolGrants {
  /** Names of the tools on this connector the caller always allows. */
  listToolGrants(req: { id: string }): Promise<string[]>;
  /** Stops always allowing one tool, so its next call asks again. */
  revokeToolGrant(req: { id: string; toolName: string }): Promise<void>;
}

/**
 * Whether a catalog carries the grant calls. Another host's catalog may not, so the connector page
 * reads for them and hides the grant controls when they are absent.
 */
export function hasConnectorToolGrants(catalog: object): catalog is ConnectorToolGrants {
  return (
    typeof Reflect.get(catalog, 'listToolGrants') === 'function' &&
    typeof Reflect.get(catalog, 'revokeToolGrant') === 'function'
  );
}

/**
 * Validates one grant listing at the boundary and projects it onto the tool names the UI reads.
 * @throws {Error} when the body does not match the contract
 */
export function parseToolGrants(body: unknown): string[] {
  const parsed = ToolGrantsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Tool grants returned an unreadable response');
  }
  return parsed.data.data.map(grant => grant.tool_name);
}
