/**
 * Approval tokens bind a Tier 3 approval to the exact action it covers.
 *
 * A token references an action id (deterministic over tool name + canonical
 * params) and a hash of the canonical params. For shell, the canonical params
 * are the full server-parsed command structure: every simple command's argv
 * with each argv[0] resolved to its absolute path at parse time, redirections
 * (including heredoc bodies, not just targets), the working directory
 * (symlinks resolved), and environment overrides. The hash also binds the
 * sha256 of executable-relevant file operands: the resolved argv[0] binary,
 * the interpreter, the script/config operand (including manifests and
 * Dockerfiles), and redirection sources that resolve to existing files. Other
 * argv tokens that resolve to files are bound by path only. Transitive runtime
 * dependencies not named in argv (dynamically imported modules, sourced files)
 * are a known limitation.
 *
 * Tokens are single-use. Immediately before invocation the server re-verifies
 * byte-for-byte against the exact parameters about to be executed; anything
 * covered by the hash that changed after approval invalidates the token and
 * the agent must request approval again. The server normalizes cwd and env
 * identically at mint and re-validation (symlinks resolved; empty or unset
 * cwd falls back to the workspace root); a normalization mismatch fails
 * closed.
 */
import { z } from '@hono/zod-openapi';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { lexicalPath, type PathResolution } from './trackedExecutables';

/** Deterministic JSON serialization: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical (stable-stringified) params. */
export function hashCanonicalParams(params: unknown): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

/**
 * Normalize canonical params to their JSON-serialized form.
 *
 * Approval tokens bind an approval to sha256(stableStringify(canonical_params)),
 * but the verify path rebuilds params with JSON.parse of the serialized
 * arguments string. Values that do not survive a JSON round-trip (class
 * instances, Dates, undefined, functions) would hash differently at mint than
 * at verify, and legitimate approvals would be rejected as "action identity
 * changed". Normalize here, at the classification choke point, so ToolSet,
 * Sandbox, and AgentThread all share the invariant.
 */
export function toJsonSafeParams(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

/** Deterministic action id over tool name + canonical params. */
export function actionIdFor(input: { tool_name: string; canonical_params: unknown }): string {
  return createHash('sha256')
    .update(`${input.tool_name}\n${stableStringify(input.canonical_params)}`)
    .digest('hex');
}

export interface ShellCommandBinding {
  /** argv per simple command, with each argv[0] resolved at parse time. */
  argv: string[];
  argv0_resolved: string | null;
}

export interface ShellApprovalBinding {
  commands: ShellCommandBinding[];
  /** Redirection targets with heredoc bodies (null body when not a heredoc). */
  redirections: { target: string; body: string | null }[];
  /** Working directory with symlinks resolved (workspace root fallback applied). */
  cwd_resolved: string | null;
  env_overrides: Record<string, string>;
  /** sha256 per executable-relevant file operand, keyed by resolved path. */
  file_hashes: Record<string, string>;
}

export const ShellApprovalBindingSchema = z
  .object({
    commands: z.array(
      z.object({
        argv: z.array(z.string()),
        argv0_resolved: z.string().nullable(),
      }),
    ),
    redirections: z.array(
      z.object({
        target: z.string(),
        body: z.string().nullable(),
      }),
    ),
    cwd_resolved: z.string().nullable(),
    env_overrides: z.record(z.string(), z.string()),
    file_hashes: z.record(z.string(), z.string()),
  })
  .describe('Host-only parsed shell binding for Tier 3 shell approvals.');

export interface ApprovalToken {
  token_id: string;
  action_id: string;
  params_hash: string;
  shell: ShellApprovalBinding | null;
  created_at: string;
}

/** Tenant and user an approval belongs to; both are required, so an unscoped token cannot exist. */
export interface ApprovalTokenScope {
  tenant_id: string;
  created_by: string;
}

export interface MintApprovalTokenInput extends ApprovalTokenScope {
  action_id: string;
  /** The caller supplies the canonical params; the store hashes them. */
  canonical_params: unknown;
  shell?: ShellApprovalBinding | null;
  /** ISO instant after which the token no longer redeems. */
  expires_at: string;
}

/** Identifies a token to look up or redeem; the scope must match the one it was minted with. */
export interface ApprovalTokenRef extends ApprovalTokenScope {
  token_id: string;
}

/**
 * Redeem is atomic and single-use: of any number of concurrent redeems of one
 * token, at most one returns it. Stores fail closed: errors propagate, and a
 * token that is missing, used, expired or outside the caller's scope reads as
 * undefined.
 */
export interface ApprovalTokenStore {
  /** Mint a token binding the action id to the canonical params hash, and drop spent tokens. */
  mint(input: MintApprovalTokenInput): Promise<ApprovalToken>;
  /** Look up a token that can still be redeemed, without consuming it. */
  peek(input: ApprovalTokenRef): Promise<ApprovalToken | undefined>;
  /** Single-use redeem: returns the token and marks it consumed. */
  redeem(input: ApprovalTokenRef): Promise<ApprovalToken | undefined>;
}

/**
 * How long a pending approval stays redeemable. Bounds how long an unanswered
 * card or an abandoned denial can leave a live token behind.
 */
export const APPROVAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalTokenExpiry(): string {
  return new Date(Date.now() + APPROVAL_TOKEN_TTL_MS).toISOString();
}

export function hasApprovalScope(scope: ApprovalTokenScope): boolean {
  return (
    typeof scope.tenant_id === 'string' &&
    scope.tenant_id.length > 0 &&
    typeof scope.created_by === 'string' &&
    scope.created_by.length > 0
  );
}

/** Token ids are bearer secrets; stores keep only this digest. */
export function hashApprovalTokenId(tokenId: string): string {
  return createHash('sha256').update(tokenId).digest('hex');
}

export interface PreparedApprovalToken {
  token: ApprovalToken;
  token_hash: string;
  /** Normalized to an ISO instant, so text comparison orders by time. */
  expires_at: string;
}

/**
 * Shared mint rules for every store: a complete scope, a parseable expiry, a
 * fresh random id, and the params hash. Throws instead of minting a token the
 * redeem path could never scope or expire.
 */
export function prepareApprovalToken(input: MintApprovalTokenInput): PreparedApprovalToken {
  if (!hasApprovalScope(input)) {
    throw new Error('Approval token requires a tenant and a user');
  }
  const expiresAt = new Date(input.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('Approval token requires a valid expiry');
  }
  const token: ApprovalToken = {
    token_id: randomBytes(16).toString('hex'),
    action_id: input.action_id,
    params_hash: hashCanonicalParams(input.canonical_params),
    shell: input.shell ?? null,
    created_at: new Date().toISOString(),
  };
  return { token, token_hash: hashApprovalTokenId(token.token_id), expires_at: expiresAt.toISOString() };
}

/** Rebuilds a token from a persisted row; a stored shell binding that no longer parses throws. */
export function restoreApprovalToken(input: {
  token_id: string;
  action_id: string;
  params_hash: string;
  shell: unknown;
  created_at: string;
}): ApprovalToken {
  return {
    token_id: input.token_id,
    action_id: input.action_id,
    params_hash: input.params_hash,
    shell: ShellApprovalBindingSchema.nullable().parse(input.shell),
    created_at: input.created_at,
  };
}

const MAX_TOKENS = 5000;

interface InMemoryEntry {
  token: ApprovalToken;
  scope: ApprovalTokenScope;
  expires_at_ms: number;
  used: boolean;
}

export class InMemoryApprovalTokenStore implements ApprovalTokenStore {
  private readonly tokens = new Map<string, InMemoryEntry>();

  mint(input: MintApprovalTokenInput): Promise<ApprovalToken> {
    // A throw inside the executor rejects, as a persisted store's failed mint would.
    return new Promise(resolve => {
      resolve(this.insert(input));
    });
  }

  private insert(input: MintApprovalTokenInput): ApprovalToken {
    const prepared = prepareApprovalToken(input);
    this.dropSpent();
    if (this.tokens.size >= MAX_TOKENS) {
      // Oldest first: insertion-ordered map, evict from the front.
      const oldest = this.tokens.keys().next();
      if (!oldest.done) {
        this.tokens.delete(oldest.value);
      }
    }
    this.tokens.set(prepared.token.token_id, {
      token: prepared.token,
      scope: { tenant_id: input.tenant_id, created_by: input.created_by },
      expires_at_ms: Date.parse(prepared.expires_at),
      used: false,
    });
    return prepared.token;
  }

  peek(input: ApprovalTokenRef): Promise<ApprovalToken | undefined> {
    return Promise.resolve(this.live(input)?.token);
  }

  redeem(input: ApprovalTokenRef): Promise<ApprovalToken | undefined> {
    const entry = this.live(input);
    if (entry === undefined) {
      return Promise.resolve(undefined);
    }
    entry.used = true;
    return Promise.resolve(entry.token);
  }

  /** Rows held, spent ones included until the next mint drops them. */
  get size(): number {
    return this.tokens.size;
  }

  private live(input: ApprovalTokenRef): InMemoryEntry | undefined {
    if (!hasApprovalScope(input)) {
      return undefined;
    }
    const entry = this.tokens.get(input.token_id);
    if (
      entry === undefined ||
      entry.used ||
      entry.expires_at_ms <= Date.now() ||
      entry.scope.tenant_id !== input.tenant_id ||
      entry.scope.created_by !== input.created_by
    ) {
      return undefined;
    }
    return entry;
  }

  private dropSpent(): void {
    const now = Date.now();
    for (const [id, entry] of this.tokens) {
      if (entry.used || entry.expires_at_ms <= now) {
        this.tokens.delete(id);
      }
    }
  }
}

export type TokenVerification = { valid: true } | { valid: false; reason: string };

/**
 * Pre-invocation byte-for-byte re-verification. The caller rebuilds the
 * canonical params from the exact parameters about to be executed (with fresh
 * file hashes); any mismatch with the minted token invalidates the approval.
 * A normalization mismatch (cwd/env resolved differently than at mint) fails
 * closed.
 */
export function verifyApprovalToken(input: {
  token: ApprovalToken;
  action_id: string;
  canonical_params: unknown;
}): TokenVerification {
  if (input.token.action_id !== input.action_id) {
    return { valid: false, reason: 'action identity changed since approval' };
  }
  const currentHash = hashCanonicalParams(input.canonical_params);
  if (currentHash !== input.token.params_hash) {
    return { valid: false, reason: 'parameters changed since approval' };
  }
  return { valid: true };
}

/**
 * Resolve and normalize a cwd identically at mint and re-validation:
 * symlinks resolved; empty or unset falls back to the workspace root.
 * Returns null on any resolution failure (fail closed).
 */
export function normalizeCwd(input: {
  cwd: string | undefined;
  workspace_root: string;
  resolution?: PathResolution | undefined;
}): string | null {
  const raw = input.cwd === undefined || input.cwd === '' ? input.workspace_root : input.cwd;
  if (input.resolution === 'remote') {
    return lexicalPath({ p: raw, cwd: input.workspace_root });
  }
  try {
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(input.workspace_root, raw);
    return realpathSync(absolute);
  } catch {
    return null;
  }
}
