import { randomBytes } from 'node:crypto';

/**
 * In-memory registry of skill network grants. A grant lets one chat reach the exact sites the
 * person approved for the skills mounted in it, and nothing else. Tokens are bearer credentials,
 * so grants live only in memory, expire on their own, and the registry is the single place that
 * issues or revokes them. Same shape as the package mirror token registry.
 */
export interface SkillNetworkGrant {
  token: string;
  tenant_id: string;
  created_by: string;
  session_id: string;
  /** The approved sites this grant covers, exactly as the gateway checks them. */
  hosts: readonly string[];
  issued_at: string;
  expires_at_ms: number;
}

const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

function grantKey(input: {
  tenant_id: string;
  created_by: string;
  session_id: string;
  hosts: readonly string[];
}): string {
  return JSON.stringify([input.tenant_id, input.created_by, input.session_id, [...input.hosts].sort()]);
}

export class SkillNetworkTokenRegistry {
  readonly #byToken = new Map<string, SkillNetworkGrant>();
  readonly #byKey = new Map<string, string>();

  /**
   * The token for a chat's approved sites, minting one when needed. A chat holds one grant at a
   * time: issuing for a different site list replaces the chat's earlier grant, so a tightened or
   * removed approval in Settings takes effect on the next command, not at some later expiry.
   * Re-issuing for the same list returns the same token, so parallel commands in one chat share it.
   */
  issue(input: { tenant_id: string; created_by: string; session_id: string; hosts: readonly string[] }): string {
    const key = grantKey(input);
    const existing = this.#byKey.get(key);
    if (existing !== undefined && this.resolve(existing) !== undefined) {
      return existing;
    }
    this.revokeSession(input.session_id);
    const now = Date.now();
    const token = randomBytes(16).toString('hex');
    const grant: SkillNetworkGrant = {
      token,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      hosts: [...input.hosts],
      issued_at: new Date(now).toISOString(),
      expires_at_ms: now + GRANT_TTL_MS,
    };
    this.#byToken.set(token, grant);
    this.#byKey.set(key, token);
    return token;
  }

  resolve(token: string): SkillNetworkGrant | undefined {
    const grant = this.#byToken.get(token);
    if (grant === undefined) {
      return undefined;
    }
    if (Date.now() > grant.expires_at_ms) {
      this.#delete(grant);
      return undefined;
    }
    return grant;
  }

  revokeSession(session_id: string): void {
    for (const grant of this.#byToken.values()) {
      if (grant.session_id === session_id) {
        this.#delete(grant);
      }
    }
  }

  #delete(grant: SkillNetworkGrant): void {
    this.#byToken.delete(grant.token);
    this.#byKey.delete(grantKey(grant));
  }
}

/** Process-wide registry; the gateway resolves against it and turn building issues into it. */
export const skillNetworkTokens = new SkillNetworkTokenRegistry();
