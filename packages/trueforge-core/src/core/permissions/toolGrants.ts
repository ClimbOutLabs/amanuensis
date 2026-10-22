/**
 * Standing per-user approvals for one connector tool ("Always allow this tool"). The server
 * persists them; core only asks whether one exists and records a new one when the user chooses
 * it on an approval.
 */

/** One user's standing approval for one tool on one connector. Never crosses any of the four. */
export interface ToolGrantIdentity {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  tool_name: string;
}

/**
 * A grant binds to the connector's host as well. A connector whose URL now points elsewhere has a
 * different host, so its grants no longer match and the next call asks again. Null for a connector
 * with no URL (a local process).
 */
export interface ToolGrantKey extends ToolGrantIdentity {
  mcp_server_host: string | null;
}

export interface ToolGrantStore {
  hasToolGrant(key: ToolGrantKey): Promise<boolean>;
  /** Idempotent: recording the same grant again leaves it unchanged; a new host replaces the binding. */
  recordToolGrant(key: ToolGrantKey): Promise<void>;
}

/** Reason code for a call a standing tool grant admitted without a card; always audited. */
export const TOOL_GRANT_REASON = 'mcp_tool_grant';

function grantId(identity: ToolGrantIdentity): string {
  return JSON.stringify([identity.tenant_id, identity.created_by, identity.mcp_server_name, identity.tool_name]);
}

/** Process-local grants for tests and hosts without durable storage. */
export class InMemoryToolGrantStore implements ToolGrantStore {
  private readonly hosts = new Map<string, string | null>();

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    const id = grantId(key);
    return Promise.resolve(this.hosts.has(id) && this.hosts.get(id) === key.mcp_server_host);
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.hosts.set(grantId(key), key.mcp_server_host);
    return Promise.resolve();
  }
}
