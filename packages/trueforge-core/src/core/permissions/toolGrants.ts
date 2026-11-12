/**
 * Standing per-user approvals for one connector tool ("Always allow everywhere"). The server
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
 * A grant binds to the connector as it was set up when the user chose "Always allow": a digest of its address
 * (path and query included) and its sign-in settings, which the host computes and never shows. A connector that
 * now points elsewhere, even on the same host, or signs in another way, has a different binding, so its grants no
 * longer match and the next call asks again. Null for a source the host set up with no address of its own.
 */
export interface ToolGrantKey extends ToolGrantIdentity {
  connector_binding: string | null;
}

export interface ToolGrantStore {
  hasToolGrant(key: ToolGrantKey): Promise<boolean>;
  /** Idempotent: recording the same grant again leaves it unchanged; a new binding replaces the old one. */
  recordToolGrant(key: ToolGrantKey): Promise<void>;
}

/** Reason code for a call a standing tool grant admitted without a card; always audited. */
export const TOOL_GRANT_REASON = 'mcp_tool_grant';

function grantId(identity: ToolGrantIdentity): string {
  return JSON.stringify([identity.tenant_id, identity.created_by, identity.mcp_server_name, identity.tool_name]);
}

/** Process-local grants for tests and hosts without durable storage. */
export class InMemoryToolGrantStore implements ToolGrantStore {
  private readonly bindings = new Map<string, string | null>();

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    const id = grantId(key);
    return Promise.resolve(this.bindings.has(id) && this.bindings.get(id) === key.connector_binding);
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.bindings.set(grantId(key), key.connector_binding);
    return Promise.resolve();
  }
}
