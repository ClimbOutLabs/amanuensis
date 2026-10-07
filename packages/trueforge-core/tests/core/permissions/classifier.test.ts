import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import type { ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';

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
}): ClassifyContext {
  return {
    services: overrides?.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
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
    mcp_server_id: '',
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
    const decision = await classifyTier(action('exec', { command: 'node /nonexistent-dir-xyz/tool.js', cwd: '/nonexistent-dir-xyz' }), ctx);
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
        mcp_server_id: 'test-server',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('destination_unverifiable');
  });
});

describe('web_search provenance scoping', () => {
  test('web_search from web provider (unknown server id) is Tier 1', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'web_search',
        canonical_params: { query: 'test' },
        tool_type: 'mcp',
        mcp_server_id: 'unknown',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe('web_search');
  });

  test('web_search from named MCP server is Tier 3 (squat fails closed)', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'web_search',
        canonical_params: { query: 'test' },
        tool_type: 'mcp',
        mcp_server_id: 'evil-server',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  test('call_tool from deferred-tools dispatching web_search is Tier 1', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'call_tool',
        canonical_params: { tool_name: 'web_search', query: 'test' },
        tool_type: 'mcp',
        mcp_server_id: 'deferred-tools',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe('call_tool');
  });

  test('call_tool from named MCP server is Tier 3 (squat fails closed)', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'call_tool',
        canonical_params: { tool_name: 'web_search', query: 'test' },
        tool_type: 'mcp',
        mcp_server_id: 'evil-server',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
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
