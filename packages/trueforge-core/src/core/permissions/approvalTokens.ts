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
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from '@hono/zod-openapi';

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

export interface ApprovalTokenStore {
  /**
   * Mint a token binding the action id to the canonical params hash. The
   * caller supplies the canonical params; the store hashes them.
   */
  mint(input: { action_id: string; canonical_params: unknown; shell?: ShellApprovalBinding | null }): ApprovalToken;
  /** Look up a token without consuming it. */
  peek(input: { token_id: string }): ApprovalToken | undefined;
  /**
   * Single-use redeem: returns the token and marks it consumed. Returns
   * undefined when the token is missing or already redeemed.
   */
  redeem(input: { token_id: string }): ApprovalToken | undefined;
  /** Drop tokens created before the cutoff (abandoned denials, restarts). */
  pruneBefore(input: { cutoff_iso: string }): void;
}

const MAX_TOKENS = 5000;

export class InMemoryApprovalTokenStore implements ApprovalTokenStore {
  private readonly tokens = new Map<string, { token: ApprovalToken; used: boolean }>();

  mint(input: { action_id: string; canonical_params: unknown; shell?: ShellApprovalBinding | null }): ApprovalToken {
    if (this.tokens.size >= MAX_TOKENS) {
      // Oldest first: insertion-ordered map, evict from the front.
      const oldest = this.tokens.keys().next();
      if (!oldest.done) {
        this.tokens.delete(oldest.value);
      }
    }
    const token: ApprovalToken = {
      token_id: randomBytes(16).toString('hex'),
      action_id: input.action_id,
      params_hash: hashCanonicalParams(input.canonical_params),
      shell: input.shell ?? null,
      created_at: new Date().toISOString(),
    };
    this.tokens.set(token.token_id, { token, used: false });
    return token;
  }

  peek(input: { token_id: string }): ApprovalToken | undefined {
    return this.tokens.get(input.token_id)?.token;
  }

  redeem(input: { token_id: string }): ApprovalToken | undefined {
    const entry = this.tokens.get(input.token_id);
    if (entry === undefined || entry.used) {
      return undefined;
    }
    entry.used = true;
    return entry.token;
  }

  pruneBefore(input: { cutoff_iso: string }): void {
    for (const [id, entry] of this.tokens) {
      if (entry.token.created_at < input.cutoff_iso) {
        this.tokens.delete(id);
      }
    }
  }
}

export type TokenVerification =
  | { valid: true }
  | { valid: false; reason: string };

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
export function normalizeCwd(input: { cwd: string | undefined; workspace_root: string }): string | null {
  try {
    const raw = input.cwd === undefined || input.cwd === '' ? input.workspace_root : input.cwd;
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(input.workspace_root, raw);
    return realpathSync(absolute);
  } catch {
    return null;
  }
}
