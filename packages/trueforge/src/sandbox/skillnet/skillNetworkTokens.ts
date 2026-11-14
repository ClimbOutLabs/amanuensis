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

/** Sites the person allowed once for one skill in one chat; they die with the chat's grant. */
interface SessionSkillHosts {
  tenant_id: string;
  created_by: string;
  session_id: string;
  skill_name: string;
  hosts: Set<string>;
  expires_at_ms: number;
}

export class SkillNetworkTokenRegistry {
  readonly #byToken = new Map<string, SkillNetworkGrant>();
  readonly #byKey = new Map<string, string>();
  /** Allow-once sites per chat and skill, keyed by session, skill. */
  readonly #sessionHosts = new Map<string, SessionSkillHosts>();
  /** Sites the gateway refused for a chat, waiting to be read by the runtime, keyed by session. */
  readonly #refusals = new Map<string, { hosts: Set<string>; expires_at_ms: number }>();
  /** First-use cards already handed to the runtime, keyed by session, skill, so one ask is raised once. */
  readonly #cardsRaised = new Set<string>();

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
    // Only the chat's earlier token goes: its allow-once sites, refusals and raised cards are
    // what the new grant was built from, so dropping them here would undo an answer just given.
    for (const grant of this.#byToken.values()) {
      if (grant.session_id === input.session_id) {
        this.#delete(grant);
      }
    }
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
    for (const [key, entry] of this.#sessionHosts) {
      if (entry.session_id === session_id) {
        this.#sessionHosts.delete(key);
      }
    }
    this.#refusals.delete(session_id);
    for (const key of this.#cardsRaised) {
      if (key.startsWith(`${session_id}\n`)) {
        this.#cardsRaised.delete(key);
      }
    }
  }

  #delete(grant: SkillNetworkGrant): void {
    this.#byToken.delete(grant.token);
    this.#byKey.delete(grantKey(grant));
  }

  /**
   * Adds sites the person allowed once for one skill in this chat. They join the chat's grant
   * until the chat's grants are revoked or they age out with the same lifetime as a grant.
   */
  addSessionHosts(input: {
    tenant_id: string;
    created_by: string;
    session_id: string;
    skill_name: string;
    hosts: readonly string[];
  }): void {
    if (input.hosts.length === 0) {
      return;
    }
    const key = `${input.session_id}\n${input.skill_name}`;
    const existing = this.#sessionHosts.get(key);
    if (existing !== undefined && existing.expires_at_ms > Date.now()) {
      for (const host of input.hosts) {
        existing.hosts.add(host);
      }
      existing.expires_at_ms = Date.now() + GRANT_TTL_MS;
      return;
    }
    this.#sessionHosts.set(key, {
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      skill_name: input.skill_name,
      hosts: new Set(input.hosts),
      expires_at_ms: Date.now() + GRANT_TTL_MS,
    });
  }

  /** The allow-once sites for one skill in one chat, or an empty list when there are none. */
  sessionHosts(input: { session_id: string; skill_name: string }): readonly string[] {
    const entry = this.#sessionHosts.get(`${input.session_id}\n${input.skill_name}`);
    if (entry === undefined) {
      return [];
    }
    if (entry.expires_at_ms <= Date.now()) {
      this.#sessionHosts.delete(`${input.session_id}\n${input.skill_name}`);
      return [];
    }
    return [...entry.hosts].sort();
  }

  /**
   * Drops every allow-once site kept for a skill that was removed, in every chat, so a skill
   * added again later under the same name starts with none of them.
   */
  forgetSkill(input: { tenant_id: string; skill_name: string }): void {
    for (const [key, entry] of this.#sessionHosts) {
      if (entry.tenant_id === input.tenant_id && entry.skill_name === input.skill_name) {
        this.#sessionHosts.delete(key);
      }
    }
  }

  /** Every live allow-once site for one skill, across the person's open chats; Settings shows these. */
  sessionHostsForSkill(input: { tenant_id: string; created_by: string; skill_name: string }): readonly string[] {
    const hosts = new Set<string>();
    for (const entry of this.#sessionHosts.values()) {
      if (
        entry.tenant_id === input.tenant_id &&
        entry.created_by === input.created_by &&
        entry.skill_name === input.skill_name &&
        entry.expires_at_ms > Date.now()
      ) {
        for (const host of entry.hosts) {
          hosts.add(host);
        }
      }
    }
    return [...hosts].sort();
  }

  /** Notes a site the gateway refused for a chat, so the runtime can ask about it with a card. */
  recordRefusal(input: { session_id: string; host: string }): void {
    const existing = this.#refusals.get(input.session_id);
    if (existing !== undefined && existing.expires_at_ms > Date.now()) {
      existing.hosts.add(input.host);
      existing.expires_at_ms = Date.now() + GRANT_TTL_MS;
      return;
    }
    this.#refusals.set(input.session_id, {
      hosts: new Set([input.host]),
      expires_at_ms: Date.now() + GRANT_TTL_MS,
    });
  }

  /** The refused sites waiting for one chat, cleared as they are read; each is handed out once. */
  drainRefusals(input: { session_id: string }): readonly string[] {
    const entry = this.#refusals.get(input.session_id);
    if (entry === undefined) {
      return [];
    }
    this.#refusals.delete(input.session_id);
    if (entry.expires_at_ms <= Date.now()) {
      return [];
    }
    return [...entry.hosts].sort();
  }

  /** True when a first-use card for this skill was already handed out in this chat and not yet answered. */
  cardRaised(input: { session_id: string; skill_name: string }): boolean {
    return this.#cardsRaised.has(`${input.session_id}\n${input.skill_name}`);
  }

  markCardRaised(input: { session_id: string; skill_name: string }): void {
    this.#cardsRaised.add(`${input.session_id}\n${input.skill_name}`);
  }

  /** An answer landed for this skill in this chat, so a later change may raise a card again. */
  clearCardRaised(input: { session_id: string; skill_name: string }): void {
    this.#cardsRaised.delete(`${input.session_id}\n${input.skill_name}`);
  }
}

/** Process-wide registry; the gateway resolves against it and turn building issues into it. */
export const skillNetworkTokens = new SkillNetworkTokenRegistry();
