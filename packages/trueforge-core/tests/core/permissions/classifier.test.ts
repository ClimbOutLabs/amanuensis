import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  withoutTier2Relaxations,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { seedShellAllowlist, type ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';
import type { Tier2ActionKind } from '../../../src/core/permissions/tier';

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
    mcp_hints: {},
  };
}

describe('classifyTier shell matrix', () => {
  test('allowlisted mycmd runs silently as Tier 1', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const decision = await classifyTier(action('exec', { command: 'mycmd -l' }), makeCtx({ services }));
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('shell_allowlist');
      expect(decision.card).toBeNull();
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

  test('offline allows the offline subset silently as Tier 1', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    services.isOffline = async () => true;
    try {
      const allowed = await classifyTier(action('exec', { command: 'ls' }), makeCtx({ services }));
      expect(allowed.tier).toBe(1);
      expect(allowed.auto_deny).toBeNull();
      const denied = await classifyTier(action('exec', { command: 'mycmd -l' }), makeCtx({ services }));
      expect(denied.tier).toBe(3);
      expect(denied.auto_deny).toBe('offline_mode');
    } finally {
      cleanup();
    }
  });
});

function relaxing(services: SentinelServices, kinds: Tier2ActionKind[]): SentinelServices {
  return { ...services, tier2AutoAllow: () => Promise.resolve(new Set(kinds)) };
}

describe('classifyTier Tier 2 asks by default', () => {
  test('an unrelaxed workspace write requires approval with a plain token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const decision = await classifyTier(
        action('write_file', { path: join(dir, 'notes.md'), content: 'x' }),
        makeCtx({ workspace_cwd: dir }),
      );
      expect(decision.tier).toBe(2);
      expect(decision.tier2_kind).toBe('file_write');
      expect(decision.card).not.toBeNull();
      expect(decision.approval_token_id).not.toBeNull();
      expect(decision.shell_binding).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a scheduled session ignores relaxations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const unattended = withoutTier2Relaxations(
        relaxing(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ['file_write']),
      );
      const decision = await classifyTier(
        action('write_file', { path: join(dir, 'notes.md'), content: 'x' }),
        makeCtx({ services: unattended, workspace_cwd: dir }),
      );
      expect(decision.tier).toBe(2);
      expect(decision.approval_token_id).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a relaxation never lowers Tier 3', async () => {
    const decision = await classifyTier(
      action('exec', { command: 'curl https://example.com' }),
      makeCtx({ services: relaxing(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ['file_write']) }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.approval_token_id).not.toBeNull();
  });

  test('offline mode is read for the calling user', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    const seen: string[] = [];
    services.isOffline = ({ created_by }) => {
      seen.push(created_by);
      return Promise.resolve(created_by === 'u1');
    };
    try {
      const offline = await classifyTier(
        action('exec', { command: 'curl https://example.com' }),
        makeCtx({ services }),
      );
      expect(offline.auto_deny).toBe('offline_mode');
      expect(seen).toEqual(['u1']);
    } finally {
      cleanup();
    }
  });
});

/** The seeded allowlist over a temp PATH holding a stub for each seeded command, inside a temp workspace. */
function seededWorkspace(): { services: SentinelServices; workspace: string; cleanup: () => void } {
  const bin = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  const workspace = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
  for (const name of ['ls', 'cat', 'pwd', 'git', 'node', 'python3', 'touch']) {
    writeFileSync(join(bin, name), '#!/bin/sh\n');
  }
  writeFileSync(join(workspace, 'notes.txt'), 'hello');
  const services = { ...defaultSentinelServices({ pinned_path: bin }), shell_allowlist: seedShellAllowlist(bin) };
  return {
    services,
    workspace,
    cleanup: () => {
      rmSync(bin, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

describe('classifyTier read-only shell commands are Tier 1', () => {
  test.each([
    'ls',
    'ls -la',
    'cat notes.txt',
    'pwd',
    'git status',
    'git log --oneline',
    'git diff --cached',
    'git show --no-patch HEAD',
    'git rev-parse --show-toplevel',
  ])('%s runs silently with no card or token', async command => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services, workspace_cwd: workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.card).toBeNull();
      expect(decision.approval_token_id).toBeNull();
      expect(decision.auto_deny).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('a scheduled session also runs them silently', async () => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const decision = await classifyTier(
        action('exec', { command: 'git status', cwd: workspace }),
        makeCtx({ services: withoutTier2Relaxations(services), workspace_cwd: workspace }),
      );
      expect(decision.tier).toBe(1);
    } finally {
      cleanup();
    }
  });

  test.each([
    ['a working directory outside the workspace', { command: 'ls', cwd: '/' }],
    ['an operand that escapes the workspace', { command: 'cat ../outside.txt' }],
    ['model-supplied environment', { command: 'ls', env: { LD_PRELOAD: '/tmp/x.so' } }],
    ['a flag that is not on the allowlist', { command: 'ls --color=auto' }],
    ['a git config override', { command: 'git -c core.pager=sh status' }],
  ])('falls back to asking for %s', async (_label, params) => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const decision = await classifyTier(
        action('exec', { cwd: workspace, ...params }),
        makeCtx({ services, workspace_cwd: workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
      // Asking must be answerable: the token and parsed binding let dispatch accept an approval.
      expect(decision.approval_token_id).not.toBeNull();
      expect(decision.shell_binding).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('offline mode keeps the same containment check', async () => {
    const { services, workspace, cleanup } = seededWorkspace();
    services.isOffline = () => Promise.resolve(true);
    try {
      const inside = await classifyTier(
        action('exec', { command: 'ls', cwd: workspace }),
        makeCtx({ services, workspace_cwd: workspace }),
      );
      expect(inside.tier).toBe(1);
      const outside = await classifyTier(
        action('exec', { command: 'ls', cwd: '/' }),
        makeCtx({ services, workspace_cwd: workspace }),
      );
      expect(outside.tier).toBe(3);
      expect(outside.reason).toBe('cwd_outside_workspace');
    } finally {
      cleanup();
    }
  });

  test('writes still ask: a shell write is Tier 3 and a file write is Tier 2', async () => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const ctx = makeCtx({ services, workspace_cwd: workspace });
      const touch = await classifyTier(action('exec', { command: 'touch new.txt', cwd: workspace }), ctx);
      expect(touch.tier).toBe(3);
      expect(touch.approval_token_id).not.toBeNull();
      const write = await classifyTier(action('write_file', { path: join(workspace, 'new.txt'), content: 'x' }), ctx);
      expect(write.tier).toBe(2);
      expect(write.approval_token_id).not.toBeNull();
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

describe('verifyPreDispatch', () => {
  test('Tier 1 and a relaxed Tier 2 call pass through without verification', async () => {
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

  test('a Tier 2 call that asked redeems its token once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
      const params = { path: join(dir, 'notes.md'), content: 'x' };
      const decision = await classifyTier(action('write_file', params), makeCtx({ services, workspace_cwd: dir }));
      const call = {
        tool_name: 'write_file',
        tool_type: 'truefoundry-system' as const,
        canonical_params: params,
        tier: 2 as const,
        approval_token_id: decision.approval_token_id,
        approval_binding: null,
        shell_binding: null,
      };
      const ctx = { ...makeCtx({ services, workspace_cwd: dir }), offline: false };
      expect(await verifyPreDispatch({ call, ctx })).toBeUndefined();
      expect(await verifyPreDispatch({ call, ctx })).toMatch(/already used|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Tier 2 token minted for other params is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
      const decision = await classifyTier(
        action('write_file', { path: join(dir, 'notes.md'), content: 'x' }),
        makeCtx({ services, workspace_cwd: dir }),
      );
      const result = await verifyPreDispatch({
        call: {
          tool_name: 'write_file',
          tool_type: 'truefoundry-system',
          canonical_params: { path: join(dir, 'notes.md'), content: 'different' },
          tier: 2,
          approval_token_id: decision.approval_token_id,
          approval_binding: null,
          shell_binding: null,
        },
        ctx: { ...makeCtx({ services, workspace_cwd: dir }), offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Tier 2 call that asked is still contained to the workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const params = { path: '/etc/passwd', content: 'x' };
      const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
      const token = services.token_store.mint({
        action_id: actionIdFor({ tool_name: 'write_file', canonical_params: params }),
        canonical_params: params,
      });
      const result = await verifyPreDispatch({
        call: {
          tool_name: 'write_file',
          tool_type: 'truefoundry-system',
          canonical_params: params,
          tier: 2,
          approval_token_id: token.token_id,
          approval_binding: null,
          shell_binding: null,
        },
        ctx: { ...makeCtx({ services, workspace_cwd: dir }), offline: false },
      });
      expect(result).toMatch(/outside the workspace/i);
      expect(services.token_store.peek({ token_id: token.token_id })).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
