import { randomBytes } from 'node:crypto';

/**
 * One package mirror grant: the token a sandbox presents, and the chat it was issued for, with the
 * repository when the chat works on one. A grant for a chat without a project has no repository:
 * its scope is the person's own download allowance for such chats.
 * Grants live in memory only. A server restart ends every grant, and the next command in the chat
 * is issued a fresh one, so nothing durable depends on them. The gateway also checks each grant
 * against the shared database, so a change made through another server ends it too.
 */
export interface PackageMirrorGrant {
  token: string;
  tenant_id: string;
  created_by: string;
  session_id: string;
  repository_id: string | undefined;
  issued_at: string;
  expires_at_ms: number;
}

/** A grant lasts half a day at most; commands re-resolve it, so an expired one is replaced silently. */
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Issues and checks the per-sandbox tokens the package mirrors accept. A token is tied to one
 * chat and one scope: a repository, or the person's chats without a project. The gateway refuses
 * a token it did not issue, one that has expired, and one whose allowance was taken back.
 */
export class PackageMirrorTokenRegistry {
  readonly #grants = new Map<string, PackageMirrorGrant>();
  readonly #tokenByGrantKey = new Map<string, string>();

  issue(input: {
    tenant_id: string;
    created_by: string;
    session_id: string;
    repository_id?: string | undefined;
  }): string {
    // An empty repository id means the same as none. Normalize it here so the stored grant and
    // its key can never disagree about the scope, and the project-less revoke always reaches it.
    const repository_id = input.repository_id === '' ? undefined : input.repository_id;
    const key = grantKey({ ...input, repository_id });
    const now = Date.now();
    const existingToken = this.#tokenByGrantKey.get(key);
    if (existingToken !== undefined) {
      const existing = this.#grants.get(existingToken);
      if (existing !== undefined && existing.expires_at_ms > now) {
        return existingToken;
      }
      this.#drop(existingToken);
    }
    const token = randomBytes(16).toString('hex');
    this.#grants.set(token, {
      token,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      session_id: input.session_id,
      repository_id,
      issued_at: new Date(now).toISOString(),
      expires_at_ms: now + GRANT_TTL_MS,
    });
    this.#tokenByGrantKey.set(key, token);
    return token;
  }

  resolve(token: string): PackageMirrorGrant | undefined {
    const grant = this.#grants.get(token);
    if (grant === undefined) {
      return undefined;
    }
    if (grant.expires_at_ms <= Date.now()) {
      this.#drop(token);
      return undefined;
    }
    return grant;
  }

  /** Takes back every grant for one repository, used the moment its download allowance is removed. */
  revokeRepository(input: { tenant_id: string; created_by: string; repository_id: string }): void {
    for (const grant of [...this.#grants.values()]) {
      if (
        grant.tenant_id === input.tenant_id &&
        grant.created_by === input.created_by &&
        grant.repository_id === input.repository_id
      ) {
        this.#drop(grant.token);
      }
    }
  }

  /** Takes back every grant the person holds for chats without a project, used the moment that allowance is removed. */
  revokePersonWithoutRepository(input: { tenant_id: string; created_by: string }): void {
    for (const grant of [...this.#grants.values()]) {
      if (
        grant.tenant_id === input.tenant_id &&
        grant.created_by === input.created_by &&
        grant.repository_id === undefined
      ) {
        this.#drop(grant.token);
      }
    }
  }

  /** Takes back one grant, used when the shared database says its allowance no longer holds. */
  revoke(token: string): void {
    this.#drop(token);
  }

  /** Takes back every grant of one chat, used when the chat is deleted. */
  revokeSession(session_id: string): void {
    for (const grant of [...this.#grants.values()]) {
      if (grant.session_id === session_id) {
        this.#drop(grant.token);
      }
    }
  }

  #drop(token: string): void {
    const grant = this.#grants.get(token);
    if (grant === undefined) {
      return;
    }
    this.#grants.delete(token);
    this.#tokenByGrantKey.delete(grantKey(grant));
  }
}

function grantKey(input: {
  tenant_id: string;
  created_by: string;
  session_id: string;
  repository_id: string | undefined;
}): string {
  // A chat without a project keys on the empty repository segment. issue normalizes an empty
  // repository id to none before keying, so the two scopes can never collide.
  return [input.tenant_id, input.created_by, input.session_id, input.repository_id ?? ''].join('\0');
}

/** The one registry the server process shares between the turn wiring and the mirror gateway. */
export const packageMirrorTokens = new PackageMirrorTokenRegistry();
