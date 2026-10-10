/**
 * Sentinel service container and per-call identity.
 *
 * The classifier and the dispatch guards need a small set of server-owned
 * services: the tracked-executable store, the approval-token store, the audit
 * writer, the shell allowlist, and readers for the per-user offline toggle
 * and Tier 2 "always ask" toggles. Defaults are in-memory and permissive
 * (offline off, no toggles) so core works without server wiring.
 */
import { InMemoryApprovalTokenStore, type ApprovalTokenStore } from './approvalTokens';
import type { AuditLogWriter } from './audit';
import { seedShellAllowlist, type ShellAllowlistConfig } from './shellAllowlist';
import type { Tier2ActionKind } from './tier';
import { InMemoryTrackedExecutableStore, type TrackedExecutableStore } from './trackedExecutables';

export interface SentinelServices {
  tracked_store: TrackedExecutableStore;
  token_store: ApprovalTokenStore;
  audit: AuditLogWriter | null;
  shell_allowlist: ShellAllowlistConfig;
  isOffline: (input: { tenant_id: string; created_by: string }) => Promise<boolean>;
  alwaysAsk: (input: { tenant_id: string; created_by: string }) => Promise<ReadonlySet<Tier2ActionKind>>;
}

/** Server-owned identity for one tool call. Never agent-supplied. */
export interface SentinelCallIdentity {
  tenant_id: string;
  created_by: string;
  /** Session id: purges tracked grants on teardown. */
  conversation_id: string;
  repository_id: string | null;
  /** Sandbox cwd for the call, when the tool runs in a workspace. */
  workspace_cwd: string | null;
  /** One sentence from the agent describing what it is trying to do, when present. */
  agent_intent: string | null;
}

/** Default pinned PATH for unconfigured servers. Matches the fallback in classifyContextFor. */
export const DEFAULT_PINNED_PATH = '/usr/bin:/bin';

/** Default services for tests and unconfigured servers. */
export function defaultSentinelServices(input: { pinned_path: string }): SentinelServices {
  return {
    tracked_store: new InMemoryTrackedExecutableStore(),
    token_store: new InMemoryApprovalTokenStore(),
    audit: null,
    shell_allowlist: seedShellAllowlist(input.pinned_path),
    isOffline: () => Promise.resolve(false),
    alwaysAsk: () => Promise.resolve(new Set<Tier2ActionKind>()),
  };
}

/**
 * Server-owned Sentinel context carried by hosts (ToolSet, Sandbox): shared
 * services plus the per-turn identity the classifier and audit log need.
 */
export interface SentinelHostContext {
  services: SentinelServices;
  tenant_id: string;
  created_by: string;
  /** Session id: purges tracked grants on teardown. */
  conversation_id: string;
  /** Workspace root for boundary checks; null when the session has no workspace. */
  workspace_cwd: string | null;
}

/**
 * Canonical factory for SentinelHostContext. Use this instead of building
 * the object literal inline, so all call sites share one construction path.
 *
 * When services are omitted, defaults are used (same as classifyContextFor).
 * For session-scoped sharing (tracked grants, approval tokens visible across
 * threads), pass the session's services explicitly.
 */
export function createSentinelHostContext(input: {
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  workspace_cwd?: string | null | undefined;
  services?: SentinelServices | undefined;
}): SentinelHostContext {
  return {
    services: input.services ?? defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    conversation_id: input.conversation_id,
    workspace_cwd: input.workspace_cwd ?? null,
  };
}

/**
 * Converts a SentinelHostContext to the { services, identity } shape expected
 * by executeToolCalls. Per-call fields not available at the host level
 * (repository_id, workspace_cwd, agent_intent) default to null.
 */
export function toDispatchSentinelContext(
  host: SentinelHostContext | undefined,
): { services: SentinelServices; identity: SentinelCallIdentity } | undefined {
  if (host === undefined) {
    return undefined;
  }
  return {
    services: host.services,
    identity: {
      tenant_id: host.tenant_id,
      created_by: host.created_by,
      conversation_id: host.conversation_id,
      repository_id: null,
      workspace_cwd: host.workspace_cwd,
      agent_intent: null,
    },
  };
}

/** Full per-call classification context from a host context. */
export function classifyContextFor(input: {
  host: SentinelHostContext | undefined;
  repository_id: string | null;
  workspace_cwd: string | null;
  agent_intent?: string | null | undefined;
}): {
  services: SentinelServices;
  tenant_id: string;
  created_by: string;
  conversation_id: string;
  repository_id: string | null;
  workspace_cwd: string | null;
  agent_intent: string | null;
} {
  const host = input.host;
  return {
    services: host?.services ?? defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    tenant_id: host?.tenant_id ?? '',
    created_by: host?.created_by ?? '',
    conversation_id: host?.conversation_id ?? '',
    repository_id: input.repository_id,
    workspace_cwd: input.workspace_cwd,
    agent_intent: input.agent_intent ?? null,
  };
}
