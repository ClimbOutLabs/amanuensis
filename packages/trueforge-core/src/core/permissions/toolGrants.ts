import type { ConnectorIdentity } from '../llm/LLMTypes';

/**
 * Standing per-user approvals for one connector tool ("Always allow this tool"). The server
 * persists them; core only asks whether one exists and records a new one when the user chooses
 * it on an approval.
 */

/**
 * One user's standing approval for one tool on one connector as configured when it was chosen.
 * Never crosses tenant, user, connector or tool; a connector whose URL or auth settings changed
 * no longer matches.
 */
export interface ToolGrantKey {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  tool_name: string;
  connector: ConnectorIdentity;
}

export interface ToolGrantStore {
  hasToolGrant(key: ToolGrantKey): Promise<boolean>;
  /** Idempotent: recording an existing grant leaves it unchanged. */
  recordToolGrant(key: ToolGrantKey): Promise<void>;
}

/** Reason code for a call a standing tool grant admitted without a card; always audited. */
export const TOOL_GRANT_REASON = 'mcp_tool_grant';

function grantId(key: ToolGrantKey): string {
  return JSON.stringify([
    key.tenant_id,
    key.created_by,
    key.mcp_server_name,
    key.tool_name,
    key.connector.id,
    key.connector.fingerprint,
  ]);
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

/**
 * Holds the grants a turn's decisions asked for until the turn has committed. A decision that is
 * refused or stale never reaches `commit`, so it saves nothing.
 */
export class TurnToolGrants implements ToolGrantStore {
  private readonly pending = new Map<string, ToolGrantKey>();

  constructor(private readonly durable: ToolGrantStore) {}

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    return this.durable.hasToolGrant(key);
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.pending.set(grantId(key), key);
    return Promise.resolve();
  }

  /** Persists what the committed turn recorded, once. */
  async commit(): Promise<void> {
    const keys = [...this.pending.values()];
    this.pending.clear();
    for (const key of keys) {
      await this.durable.recordToolGrant(key);
    }
  }
}
