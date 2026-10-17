/**
 * Sentinel service container and per-call identity.
 *
 * The classifier and the dispatch guards need a small set of server-owned
 * services: the tracked-executable store, the approval-token store, the audit
 * writer, the shell allowlist, the per-user connector tool grants, and readers
 * for the per-user offline toggle and Tier 2 relaxations. Defaults are
 * in-memory (offline off, nothing relaxed, so Tier 2 asks) so core works
 * without server wiring.
 */
import { InMemoryApprovalTokenStore, type ApprovalTokenStore } from './approvalTokens';
import type { AuditLogWriter } from './audit';
import { InMemoryPrivateDataReadStore, type PrivateDataReadStore } from './privateDataReads';
import { seedShellAllowlist, type ShellAllowlistConfig } from './shellAllowlist';
import type { Tier2ActionKind } from './tier';
import { InMemoryToolGrantStore, type ToolGrantStore } from './toolGrants';
import { InMemoryTrackedExecutableStore, type TrackedExecutableStore } from './trackedExecutables';
import { createWebSearchTurnState, type WebSearchTurnState } from './webSearch';

export interface SentinelServices {
  tracked_store: TrackedExecutableStore;
  token_store: ApprovalTokenStore;
  audit: AuditLogWriter | null;
  shell_allowlist: ShellAllowlistConfig;
  tool_grants: ToolGrantStore;
  /** Chats that have read something private, for the search provider's silent runs. */
  private_reads: PrivateDataReadStore;
  isOffline: (input: { tenant_id: string; created_by: string }) => Promise<boolean>;
  /** Tier 2 kinds the user relaxed to run without asking. */
  tier2AutoAllow: (input: { tenant_id: string; created_by: string }) => Promise<ReadonlySet<Tier2ActionKind>>;
  /** Whether the user lets the designated search provider run without asking. Default on. */
  searchWithoutAsking: (input: { tenant_id: string; created_by: string }) => Promise<boolean>;
  /** Exact secret values the host holds for this user, for the outbound secret guard. */
  outboundSecrets: (input: { tenant_id: string; created_by: string }) => Promise<readonly string[]>;
  /** True when no person watches this turn (a scheduled run), so a call that would ask is held for the owner. */
  unattended: boolean;
  /** On a demo instance, the only addresses mail may go to; null when this is not a demo. Empty allows no send. */
  demoSendAllowlist: readonly string[] | null;
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
    tool_grants: new InMemoryToolGrantStore(),
    private_reads: new InMemoryPrivateDataReadStore(),
    isOffline: () => Promise.resolve(false),
    tier2AutoAllow: () => Promise.resolve(new Set<Tier2ActionKind>()),
    searchWithoutAsking: () => Promise.resolve(true),
    outboundSecrets: () => Promise.resolve([]),
    unattended: false,
    demoSendAllowlist: null,
  };
}

/**
 * Services with the user's Tier 2 relaxations switched off, so such an action asks. Used for every
 * turn of a scheduled chat: its context holds what the run read, so the owner's relaxations must
 * not apply even once they are typing. Token and grant stores stay shared with the session.
 */
export function withoutRelaxations(services: SentinelServices): SentinelServices {
  return { ...services, tier2AutoAllow: () => Promise.resolve(new Set<Tier2ActionKind>()) };
}

/**
 * Services for one unattended turn: no relaxations, and a call that would ask is held for the
 * owner while nobody watches.
 */
export function forUnattendedRun(services: SentinelServices): SentinelServices {
  return { ...withoutRelaxations(services), unattended: true };
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
  /** Host state for the turn's silent web searches. Shared by every thread of the turn. */
  web_search: WebSearchTurnState;
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
  /** The turn's search state; omit for a context that is its own turn. */
  web_search?: WebSearchTurnState | undefined;
}): SentinelHostContext {
  return {
    services: input.services ?? defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    conversation_id: input.conversation_id,
    workspace_cwd: input.workspace_cwd ?? null,
    web_search: input.web_search ?? createWebSearchTurnState(),
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
  web_search: WebSearchTurnState;
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
    web_search: host?.web_search ?? createWebSearchTurnState(),
  };
}
