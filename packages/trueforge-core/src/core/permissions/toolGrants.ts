/**
 * Standing per-user approvals for one connector tool ("Always allow this tool"). The server
 * persists them; core only asks whether one exists and records a new one when the user chooses
 * it on an approval.
 */

/** One user's standing approval for one tool on one connector. Never crosses any of the four. */
export interface ToolGrantKey {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  tool_name: string;
}

export interface ToolGrantStore {
  hasToolGrant(key: ToolGrantKey): Promise<boolean>;
  /** Idempotent: recording an existing grant leaves it unchanged. */
  recordToolGrant(key: ToolGrantKey): Promise<void>;
}

/** Reason code for a call a standing tool grant admitted without a card; always audited. */
export const TOOL_GRANT_REASON = 'mcp_tool_grant';

function grantId(key: ToolGrantKey): string {
  return JSON.stringify([key.tenant_id, key.created_by, key.mcp_server_name, key.tool_name]);
}

/** Process-local grants for tests and hosts without durable storage. */
export class InMemoryToolGrantStore implements ToolGrantStore {
  private readonly grants = new Set<string>();

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    return Promise.resolve(this.grants.has(grantId(key)));
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.grants.add(grantId(key));
    return Promise.resolve();
  }
}
