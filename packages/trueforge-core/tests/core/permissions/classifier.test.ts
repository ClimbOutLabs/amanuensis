import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import {
  classifyHostToolCall,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import type { ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';
import { TOOL_GRANT_REASON, type ToolGrantKey, type ToolGrantStore } from '../../../src/core/permissions/toolGrants';

/**
 * Environment-independent allowlist: a temp dir with one fake `mycmd`
 * executable, wired into the services the classifier reads.
 */
function servicesWithTempAllowlist(): { services: SentinelServices; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, 'mycmd'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'ls'), '#!/bin/sh\n');
  const shell_allowlist: ShellAllowlistConfig = {
    pinned_path: dir,
    commands: {
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true },
      ls: { args: ['-l'], operands: 'workspace_relative', offline_ok: true },
    },
  };
  const services = defaultSentinelServices({ pinned_path: dir });
  services.shell_allowlist = shell_allowlist;
  return { services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCtx(overrides?: {
  services?: SentinelServices;
  workspace_cwd?: string | null;
  conversation_id?: string;
  created_by?: string;
}): ClassifyContext {
  return {
    services: overrides?.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: overrides?.created_by ?? 'u1',
    conversation_id: overrides?.conversation_id ?? 'conv-1',
    repository_id: 'r1',
    workspace_cwd: overrides?.workspace_cwd ?? null,
    agent_intent: null,
  };
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_hints: {},
  };
}

describe('classifyTier shell matrix', () => {
  test('allowlisted mycmd is Tier 2 shell', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const decision = await classifyTier(action('exec', { command: 'mycmd -l' }), makeCtx({ services }));
      expect(decision.tier).toBe(2);
      expect(decision.tier2_kind).toBe('shell');
      expect(decision.approval_token_id).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('non-allowlisted curl is Tier 3 with a card and token', async () => {
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.shell_binding).not.toBeNull();
  });

  test('compound shell is Tier 3', async () => {
    const decision = await classifyTier(action('exec', { command: 'ls | head -5' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('shell_not_allowlisted');
  });

  test('unrecognized tool fails closed to Tier 3', async () => {
    const decision = await classifyTier(action('some_unknown_tool', {}), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
    expect(decision.card).not.toBeNull();
  });

  test('offline auto-denies non-subset shell', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.isOffline = async () => true;
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('offline_mode');
  });

  test('offline allows the offline subset as Tier 2', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    services.isOffline = async () => true;
    try {
      const allowed = await classifyTier(action('exec', { command: 'ls' }), makeCtx({ services }));
      expect(allowed.tier).toBe(2);
      expect(allowed.auto_deny).toBeNull();
      const denied = await classifyTier(action('exec', { command: 'mycmd -l' }), makeCtx({ services }));
      expect(denied.tier).toBe(3);
      expect(denied.auto_deny).toBe('offline_mode');
    } finally {
      cleanup();
    }
  });
});

describe('classifyTier tracked executables', () => {
  test('executing an agent-written script escalates to Tier 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-tracked-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n');
      const ctx = makeCtx({ workspace_cwd: dir });
      ctx.services.tracked_store.track({
        scope: { tenant_id: 't1', created_by: 'u1', repository_id: 'r1', workspace_cwd: dir },
        file_identity: script,
      });
      const decision = await classifyTier(action('exec', { command: 'sh tool.sh', cwd: dir }), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('tracked_executable_unapproved');
      expect(decision.approval_binding).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unresolvable executed operand fails closed', async () => {
    const ctx = makeCtx({ workspace_cwd: '/nonexistent-dir-xyz' });
    const decision = await classifyTier(
      action('exec', { command: 'node /nonexistent-dir-xyz/tool.js', cwd: '/nonexistent-dir-xyz' }),
      ctx,
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('tracked_check_unresolvable');
  });
});

describe('classifyTier external services', () => {
  test('external action with unverifiable destination auto-denies', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'send_email',
        canonical_params: { subject: 'hi' },
        tool_type: 'mcp',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('destination_unverifiable');
  });
});

/** A grant store the test can revoke from, keyed exactly like the server store. */
class RevocableGrantStore implements ToolGrantStore {
  private readonly grants = new Set<string>();

  private static id(key: ToolGrantKey): string {
    return JSON.stringify([key.tenant_id, key.created_by, key.mcp_server_name, key.tool_name]);
  }

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    return Promise.resolve(this.grants.has(RevocableGrantStore.id(key)));
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.grants.add(RevocableGrantStore.id(key));
    return Promise.resolve();
  }

  revoke(key: ToolGrantKey): void {
    this.grants.delete(RevocableGrantStore.id(key));
  }
}

describe('classifyTier connector tools and standing grants', () => {
  const closedWorldRead: SentinelAction['mcp_hints'] = { read_only_hint: true, open_world_hint: false };
  const grantKey: ToolGrantKey = {
    tenant_id: 't1',
    created_by: 'u1',
    mcp_server_name: 'notes',
    tool_name: 'lookup_record',
  };

  function connectorAction(input?: {
    tool_name?: string;
    mcp_server_name?: string;
    mcp_hints?: SentinelAction['mcp_hints'];
    canonical_params?: Record<string, unknown>;
  }): SentinelAction {
    return {
      tool_name: input?.tool_name ?? grantKey.tool_name,
      canonical_params: input?.canonical_params ?? { id: '1' },
      tool_type: 'mcp',
      mcp_server_name: input?.mcp_server_name ?? grantKey.mcp_server_name,
      mcp_hints: input?.mcp_hints ?? closedWorldRead,
    };
  }

  function grantedServices(keys: ToolGrantKey[] = [grantKey]): {
    services: SentinelServices;
    grants: RevocableGrantStore;
  } {
    const grants = new RevocableGrantStore();
    for (const key of keys) {
      void grants.recordToolGrant(key);
    }
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.tool_grants = grants;
    return { services, grants };
  }

  test('a read-only, explicitly closed-world connector tool still asks: its own hints never lower it', async () => {
    const decision = await classifyTier(connectorAction(), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
  });

  test('an unannotated connector tool asks', async () => {
    const decision = await classifyTier(connectorAction({ mcp_hints: {} }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  test('a standing grant runs the tool at Tier 1 without a card', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(connectorAction(), makeCtx({ services }));
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe(TOOL_GRANT_REASON);
    expect(decision.card).toBeNull();
  });

  test('a grant is ignored once the tool omits openWorldHint, since absent means open-world', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { read_only_hint: true } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
  });

  test('a grant is ignored once the tool claims to reach the open world', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { read_only_hint: true, open_world_hint: true } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
  });

  test('a grant is ignored once the tool stops claiming to be read-only', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { read_only_hint: false, open_world_hint: false } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
  });

  test('a destructive hint escalates over a grant', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { ...closedWorldRead, destructive_hint: true } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_destructive_hint');
  });

  test('a destructive tool name escalates over a grant', async () => {
    const key = { ...grantKey, tool_name: 'delete_record' };
    const { services } = grantedServices([key]);
    const decision = await classifyTier(connectorAction({ tool_name: key.tool_name }), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('destructive_action');
  });

  test('an external-service action escalates over a grant', async () => {
    const key = { ...grantKey, tool_name: 'send_email' };
    const { services } = grantedServices([key]);
    const decision = await classifyTier(
      connectorAction({ tool_name: key.tool_name, canonical_params: { to: 'someone@example.com', subject: 'hi' } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('external_service');
  });

  test('a sensitive read escalates over a grant', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      connectorAction({ canonical_params: { path: '/home/someone/.ssh/id_ed25519' } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.sensitive_read).toBe(true);
  });

  test('offline mode auto-denies a granted tool', async () => {
    const { services } = grantedServices();
    services.isOffline = () => Promise.resolve(true);
    const decision = await classifyTier(connectorAction(), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('offline_mode');
  });

  test('a grant does not cross tools, connectors, or users', async () => {
    const { services } = grantedServices();
    const otherTool = await classifyTier(connectorAction({ tool_name: 'lookup_other' }), makeCtx({ services }));
    const otherConnector = await classifyTier(connectorAction({ mcp_server_name: 'tracker' }), makeCtx({ services }));
    const otherUser = await classifyTier(connectorAction(), makeCtx({ services, created_by: 'u2' }));
    expect([otherTool.tier, otherConnector.tier, otherUser.tier]).toEqual([3, 3, 3]);
  });

  test('a revoked grant asks again', async () => {
    const { services, grants } = grantedServices();
    expect((await classifyTier(connectorAction(), makeCtx({ services }))).tier).toBe(1);
    grants.revoke(grantKey);
    expect((await classifyTier(connectorAction(), makeCtx({ services }))).tier).toBe(3);
  });

  test('a built-in tool never reads connector grants', async () => {
    const { services } = grantedServices();
    const decision = await classifyTier(
      { ...connectorAction({ mcp_hints: {} }), tool_type: 'truefoundry-system' },
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
  });

  test('classifying a granted call writes no audit entry: the run is recorded once, at dispatch', async () => {
    const { services } = grantedServices();
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
      updateOutcome: () => Promise.resolve(),
    };
    const sentinel = createSentinelHostContext({ tenant_id: 't1', created_by: 'u1', conversation_id: 'c1', services });

    const decision = await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: connectorAction(),
    });

    expect(decision.reason).toBe(TOOL_GRANT_REASON);
    expect(recorded).toEqual([]);
  });
});

describe('verifyPreDispatch', () => {
  test('Tier 1/2 pass through without verification', async () => {
    const ctx = makeCtx();
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'read_file',
        tool_type: 'truefoundry-system',
        canonical_params: {},
        tier: 1,
        approval_token_id: null,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...ctx, offline: false },
    });
    expect(result).toBeUndefined();
  });

  test('missing token on a Tier 3 call fails closed', async () => {
    const ctx = makeCtx();
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: { command: 'curl https://example.com' },
        tier: 3,
        approval_token_id: null,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...ctx, offline: false },
    });
    expect(result).toMatch(/token/i);
  });

  test('a redeemed token cannot verify twice', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'curl https://example.com' };
    const token = services.token_store.mint({
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const call = {
      tool_name: 'exec',
      tool_type: 'truefoundry-system' as const,
      canonical_params: params,
      tier: 3 as const,
      approval_token_id: token.token_id,
      approval_binding: null,
      shell_binding: null,
    };
    const ctx = { ...makeCtx({ services }), offline: false };
    expect(await verifyPreDispatch({ call, ctx })).toBeUndefined();
    const second = await verifyPreDispatch({ call, ctx });
    expect(second).toMatch(/already used|invalid/i);
  });

  test('stale offline context blocks an approved shell call', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'curl https://example.com' };
    const token = services.token_store.mint({
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: params,
        tier: 3,
        approval_token_id: token.token_id,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...makeCtx({ services }), offline: true },
    });
    expect(result).toMatch(/offline/i);
  });

  test('changed params invalidate the token', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const params = { command: 'ls -la' };
    const token = services.token_store.mint({
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: { command: 'ls -la /etc' },
        tier: 3,
        approval_token_id: token.token_id,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...makeCtx({ services }), offline: false },
    });
    expect(result).toMatch(/changed|invalid/i);
  });
});
