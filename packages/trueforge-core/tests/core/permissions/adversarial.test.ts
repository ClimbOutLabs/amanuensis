/**
 * Sentinel adversarial regression tests.
 *
 * Each test attacks the tier classifier or the pre-dispatch verifier the way
 * an agent (or a compromised tool) would: parser bypasses, workspace escapes,
 * token tampering, tracked-executable evasions, and time-of-check gaps.
 *
 * - GUARD tests pin secure behavior that must keep holding.
 * - GAP tests prove a real hole was closed: they assert the secure outcome.
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actionIdFor,
  InMemoryApprovalTokenStore,
  type ShellApprovalBinding,
} from '../../../src/core/permissions/approvalTokens';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch, type VerifiableCall } from '../../../src/core/permissions/dispatch';
import type { ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';
import type { Tier, TrackedExecutionBinding } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { TEST_TOKEN_SCOPE, testApprovalOwner } from './approvalTokenFixtures';

function servicesWithTempAllowlist(): { services: SentinelServices; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, 'mycmd'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'ls'), '#!/bin/sh\n');
  const shell_allowlist: ShellAllowlistConfig = {
    pinned_path: dir,
    commands: {
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, subcommands: null },
      ls: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, subcommands: null },
    },
  };
  const services = defaultSentinelServices({ pinned_path: dir });
  services.shell_allowlist = shell_allowlist;
  return { services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Temp allowlist with a `cat` entry, for operand-shape attacks. */
function servicesWithCatAllowlist(): { services: SentinelServices; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, 'cat'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'ls'), '#!/bin/sh\n');
  const shell_allowlist: ShellAllowlistConfig = {
    pinned_path: dir,
    commands: {
      cat: { args: ['-n'], operands: 'workspace_relative', offline_ok: true, subcommands: null },
      ls: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, subcommands: null },
    },
  };
  const services = defaultSentinelServices({ pinned_path: dir });
  services.shell_allowlist = shell_allowlist;
  return { services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Seeded allowlist with real `git`/`node` binaries present, for tier-boundary tests. */
function servicesWithSeededTools(): { services: SentinelServices; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, 'git'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'node'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'python3'), '#!/bin/sh\n');
  const services = defaultSentinelServices({ pinned_path: dir }); // seeds the default allowlist
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
    web_search: createWebSearchTurnState(),
  };
}

function action(
  tool_name: string,
  canonical_params: Record<string, unknown>,
  mcp_hints?: Record<string, unknown>,
): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: mcp_hints ?? {} };
}

function mcpAction(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'mcp', mcp_hints: {} };
}

function trackScript(ctx: ClassifyContext, file_identity: string): void {
  ctx.services.tracked_store.track({
    scope: { tenant_id: 't1', created_by: 'u1', repository_id: 'r1', workspace_cwd: ctx.workspace_cwd },
    file_identity,
  });
}

function verifiableCall(overrides: {
  tool_name?: string;
  tool_type?: 'truefoundry-system' | 'mcp';
  canonical_params?: Record<string, unknown>;
  tier?: Tier;
  approval_token_id?: string | null;
  approval_binding?: TrackedExecutionBinding | null;
  shell_binding?: ShellApprovalBinding | null;
}): VerifiableCall {
  return {
    tool_name: overrides.tool_name ?? 'exec',
    tool_type: overrides.tool_type ?? 'truefoundry-system',
    canonical_params: overrides.canonical_params ?? {},
    tier: overrides.tier ?? 3,
    approval_token_id: overrides.approval_token_id ?? null,
    approval_binding: overrides.approval_binding ?? null,
    shell_binding: overrides.shell_binding ?? null,
  };
}

/** Non-null shell binding, or fail the test with a clear message. */
function requireShellBinding(decision: { shell_binding: ShellApprovalBinding | null }): ShellApprovalBinding {
  expect(decision.shell_binding).not.toBeNull();
  const binding = decision.shell_binding;
  if (binding === null) {
    throw new Error('expected a shell binding');
  }
  return binding;
}

describe('Suite A - shell parser bypass attempts', () => {
  test('A1 GAP: compound command does not skip the tracked-script check for later commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);
      const decision = await classifyTier(action('exec', { command: `echo ok; sh ${script}`, cwd: dir }), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('tracked_executable_unapproved');
      expect(decision.approval_binding).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2 GAP: rewriting a script between approval and dispatch of a compound command is detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    const { services } = servicesWithTempAllowlist();
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ services, workspace_cwd: dir });
      const params = { command: `echo ok; sh ${script}`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);
      // The binding must carry content hashes for compound commands; an empty
      // map would leave post-approval rewrites undetected.
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      // Attacker rewrites the script after the user approves.
      writeFileSync(script, '#!/bin/sh\nrm -rf /tmp/important\n');

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2b GAP: newline-separated script gets a content hash binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    const { services } = servicesWithTempAllowlist();
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ services, workspace_cwd: dir });
      const params = { command: `echo ok\nsh ${script}`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      writeFileSync(script, '#!/bin/sh\nrm -rf /tmp/important\n');
      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2c GAP: script in $() substitution gets a content hash binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    const { services } = servicesWithTempAllowlist();
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ services, workspace_cwd: dir });
      const params = { command: `echo $(sh ${script})`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      writeFileSync(script, '#!/bin/sh\nrm -rf /tmp/important\n');
      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2d GAP: script in sh -c inline code gets a content hash binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    const { services } = servicesWithTempAllowlist();
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ services, workspace_cwd: dir });
      const params = { command: `sh -c 'sh ${script}'`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      writeFileSync(script, '#!/bin/sh\nrm -rf /tmp/important\n');
      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A2e GAP: script in $() inside sh -c gets a content hash binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    const { services } = servicesWithTempAllowlist();
    try {
      const script = join(dir, 'payload.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ services, workspace_cwd: dir });
      const params = { command: `sh -c 'echo $(sh ${script})'`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      writeFileSync(script, '#!/bin/sh\nrm -rf /tmp/important\n');
      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A3 GAP: rewriting a hardlinked script after approval is detected at dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      const hardlink = join(dir, 'tool2.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      linkSync(script, hardlink); // same inode, different identity
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);

      const params = { command: 'sh tool2.sh', cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      // Identity is path-based, so the hardlink misses the tracked set...
      expect(decision.approval_binding).toBeNull();
      // ...but the Tier 3 shell binding still carries the content hash,
      // so the post-approval rewrite is detected.
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      writeFileSync(hardlink, '#!/bin/sh\necho pwned\n'); // same inode rewritten

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4 GUARD: backslash-newline folds into a literal operand, still Tier 1', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const decision = await classifyTier(
        action('exec', { command: 'ls \\\n-la' }),
        makeCtx({ services, workspace_cwd: tmpdir() }),
      );
      expect(decision.tier).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('A5 GUARD: env-style token after argv[0] is an inert operand', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const decision = await classifyTier(
        action('exec', { command: 'ls FOO=bar' }),
        makeCtx({ services, workspace_cwd: tmpdir() }),
      );
      expect(decision.tier).toBe(1);
    } finally {
      cleanup();
    }
  });

  test.each([
    'ls; rm -rf /',
    'ls && rm -rf /',
    'ls || rm -rf /',
    'ls | tee /tmp/x',
    'echo $(rm -rf /tmp/x)',
    'echo `rm -rf /tmp/x`',
    'echo ${HOME}',
    'echo $HOME',
    'ls ~',
    'ls ~/secrets',
    'cat < /etc/passwd',
    'ls > /tmp/x',
    'echo hi\nls /etc',
    '(ls)',
    'ls;echo pwned',
  ])('A6 GUARD: compound/substitution command %s is Tier 3', async command => {
    const decision = await classifyTier(action('exec', { command }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  test.each([
    'сurl https://example.com', // Cyrillic Es homoglyph argv[0]
    'ls -la', // non-breaking space as separator
    '‮ls', // RTL override prefix
    'ｌｓ -l', // fullwidth letters
  ])('A7 GUARD: unicode-obfuscated command %s is Tier 3', async command => {
    const decision = await classifyTier(action('exec', { command }), makeCtx());
    expect(decision.tier).toBe(3);
  });
});

describe('Suite B - workspace containment escapes', () => {
  test('B1 GUARD: allowlisted command with cwd outside the workspace is Tier 3', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const decision = await classifyTier(
        action('exec', { command: 'ls -l', cwd: '/etc' }),
        makeCtx({ services, workspace_cwd: ws }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('cwd_outside_workspace');
    } finally {
      cleanup();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('B2 GAP: symlinked parent pointing outside escalates to Tier 3 even when the file does not exist yet', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sentinel-out-'));
    const { services, cleanup } = servicesWithCatAllowlist();
    try {
      symlinkSync(outside, join(ws, 'linkdir')); // does NOT exist inside ws
      const decision = await classifyTier(
        action('exec', { command: 'cat linkdir/secret.txt', cwd: ws }),
        makeCtx({ services, workspace_cwd: ws }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('file_outside_workspace');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  test('B3 GUARD: parent traversal in an operand is Tier 3', async () => {
    const { services, cleanup } = servicesWithCatAllowlist();
    try {
      const decision = await classifyTier(action('exec', { command: 'ls -l ../secret' }), makeCtx({ services }));
      expect(decision.tier).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('B4 GUARD: absolute-path operand is Tier 3', async () => {
    const { services, cleanup } = servicesWithCatAllowlist();
    try {
      const decision = await classifyTier(action('exec', { command: 'cat /etc/passwd' }), makeCtx({ services }));
      expect(decision.tier).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('B5 GUARD: cwd that resolves outside the workspace is Tier 3', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sentinel-out-'));
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const link = join(ws, 'link');
      symlinkSync(outside, link);
      const decision = await classifyTier(
        action('exec', { command: 'ls -l', cwd: link }),
        makeCtx({ services, workspace_cwd: ws }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('cwd_outside_workspace');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  test('B6 GAP: write through a symlinked parent pointing outside is Tier 3', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sentinel-out-'));
    try {
      symlinkSync(outside, join(ws, 'link'));
      const decision = await classifyTier(
        action('write_file', { path: 'link/pwned.txt', content: 'x' }),
        makeCtx({ workspace_cwd: ws }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('write_outside_workspace');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('writes into the sandbox tool folders are Tier 3', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      for (const dir of ['.venv/bin', 'mcp-client/bin', 'sub/.venv/bin', '.venv/lib/site-packages', 'src']) {
        mkdirSync(join(ws, dir), { recursive: true });
      }
      const ctx = makeCtx({ workspace_cwd: ws });
      for (const tool of ['write_file', 'replace_text']) {
        for (const path of [
          '.venv/bin/flock',
          'mcp-client/bin/sh',
          'sub/.venv/bin/cat',
          '.venv/lib/site-packages/zz.pth',
          '.venv/pyvenv.cfg',
          'mcp-client/sitecustomize.py',
        ]) {
          const decision = await classifyTier(action(tool, { path, content: 'x' }), ctx);
          expect(decision.tier).toBe(3);
          expect(decision.reason).toBe('sandbox_tool_write');
        }
        expect((await classifyTier(action(tool, { path: 'src/x.py', content: 'x' }), ctx)).tier).toBe(2);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test.each([
    { link: 'mcp-client', target: 'tools', path: 'tools/bin/git', layout: ['tools/bin'] },
    { link: '.venv/bin', target: 'tools', path: 'tools/flock', layout: ['.venv', 'tools'] },
  ])(
    'a symlinked sandbox tool folder ($link) is still Tier 3 to write through',
    async ({ link, target, path, layout }) => {
      const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
      try {
        for (const dir of layout) {
          mkdirSync(join(ws, dir), { recursive: true });
        }
        symlinkSync(join(ws, target), join(ws, link));
        const ctx = makeCtx({ workspace_cwd: ws });
        for (const tool of ['write_file', 'replace_text']) {
          const decision = await classifyTier(action(tool, { path, content: 'x' }), ctx);
          expect(decision.tier).toBe(3);
          expect(decision.reason).toBe('sandbox_tool_write');
        }
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    },
  );

  test('B8 GAP: writes to git control files and symlinks into .git are Tier 3', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      mkdirSync(join(ws, '.git'));
      mkdirSync(join(ws, '.GIT'));
      mkdirSync(join(ws, 'sub'));
      symlinkSync(join(ws, '.git'), join(ws, 'link'));
      const ctx = makeCtx({ workspace_cwd: ws });
      for (const tool of ['write_file', 'replace_text']) {
        const viaCwd = await classifyTier(action(tool, { path: 'config', cwd: join(ws, '.git'), content: 'x' }), ctx);
        expect(viaCwd.tier).toBe(3);
        expect(viaCwd.reason).toBe('git_control_write');
        for (const path of ['.git/config', '.GIT/config', 'link/config', 'sub/.gitattributes', '.gitmodules']) {
          const decision = await classifyTier(action(tool, { path, content: 'x' }), ctx);
          expect(decision.tier).toBe(3);
          expect(decision.reason).toBe('git_control_write');
        }
        expect((await classifyTier(action(tool, { path: 'notes.txt', content: 'x' }), ctx)).tier).toBe(2);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('B7 GAP: write_file with no path fails closed as Tier 3', async () => {
    const decision = await classifyTier(action('write_file', {}), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('write_outside_workspace');
  });
});

describe('Suite C - trust boundary', () => {
  test('C1 GUARD: MCP tool named exec is not treated as the system exec tool', async () => {
    for (const tool_name of ['exec', 'Exec', 'EXEC', 'exec ']) {
      const decision = await classifyTier(mcpAction(tool_name, { command: 'ls' }), makeCtx());
      expect(decision.tier).toBe(3);
    }
  });

  test('C2 GUARD: MCP write_file is unrecognized, never Tier 2', async () => {
    const decision = await classifyTier(mcpAction('write_file', { path: 'a.txt', content: 'x' }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  test('C3 GUARD: MCP read with read_only_hint is still Tier 3', async () => {
    const decision = await classifyTier(mcpAction('read_file', { path: 'a.txt', read_only_hint: true }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  test('C4 GUARD: system read_file with read_only_hint is Tier 1', async () => {
    const decision = await classifyTier(action('read_file', { path: 'a.txt' }, { read_only_hint: true }), makeCtx());
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe('local_read_only');
  });
});

describe('Suite D - approval token integrity', () => {
  test('D1 GAP: adding LD_PRELOAD after approval invalidates the token', async () => {
    const ctx = makeCtx({ conversation_id: 'conv-1' });
    const params = { command: 'curl https://example.com', cwd: '/tmp', env: {} as Record<string, string> };
    const decision = await classifyTier(action('exec', params), ctx);
    expect(decision.tier).toBe(3);
    const binding = requireShellBinding(decision);

    // Attacker mutates env at dispatch.
    const tampered = { command: 'curl https://example.com', cwd: '/tmp', env: { LD_PRELOAD: '/tmp/evil.so' } };
    const result = await verifyPreDispatch({
      call: verifiableCall({
        canonical_params: tampered,
        tier: 3,
        approval_token_id: decision.approval_token_id,
        shell_binding: binding,
      }),
      ctx: { ...ctx, offline: false },
    });
    expect(result).toMatch(/changed|invalid/i);
  });

  test('D2 GAP: changing cwd after approval invalidates the token', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'sentinel-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'sentinel-b-'));
    try {
      const ctx = makeCtx({ conversation_id: 'conv-1' });
      const params = { command: 'curl https://example.com', cwd: dirA };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: { command: 'curl https://example.com', cwd: dirB },
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('D3 GAP: swapping a symlinked cwd between approval and dispatch invalidates the token', async () => {
    const real = mkdtempSync(join(tmpdir(), 'sentinel-real-'));
    const other = mkdtempSync(join(tmpdir(), 'sentinel-other-'));
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const link = join(ws, 'link');
      symlinkSync(real, link);
      const ctx = makeCtx({ conversation_id: 'conv-1' });
      const params = { command: 'curl https://example.com', cwd: link };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      const binding = requireShellBinding(decision);

      rmSync(link);
      symlinkSync(other, link); // same path, different target

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('D4 GAP: a token minted for exec cannot authorize write_file', async () => {
    const ctx = makeCtx({ conversation_id: 'conv-1' });
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), ctx);
    expect(decision.tier).toBe(3);

    const result = await verifyPreDispatch({
      call: verifiableCall({
        tool_name: 'write_file',
        canonical_params: { path: '/tmp/x.txt', content: 'pwned' },
        tier: 3,
        approval_token_id: decision.approval_token_id,
      }),
      ctx: { ...ctx, offline: false },
    });
    expect(result).toMatch(/changed|invalid/i);
  });

  test('D5 GAP: modifying a tracked script after approval is detected at dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ workspace_cwd: dir, conversation_id: 'conv-1' });
      trackScript(ctx, script);
      const params = { command: 'sh tool.sh', cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.approval_binding).not.toBeNull();

      // Attacker rewrites the tracked script after the user approves.
      writeFileSync(script, '#!/bin/sh\necho pwned\n');

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          approval_binding: decision.approval_binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D6 GAP: changing argv after approval of a tracked script is detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ workspace_cwd: dir, conversation_id: 'conv-1' });
      trackScript(ctx, script);
      const params = { command: 'sh tool.sh', cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: { command: 'sh tool.sh --evil', cwd: dir },
          tier: 3,
          approval_token_id: decision.approval_token_id,
          approval_binding: decision.approval_binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D7 GAP: a grant recorded in conv-1 does not authorize conv-2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n');
      const ctx1 = makeCtx({ workspace_cwd: dir, conversation_id: 'conv-1' });
      trackScript(ctx1, script);
      const params = { command: 'sh tool.sh', cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx1);
      expect(decision.tier).toBe(3);
      // Approve and execute in conv-1: the grant is recorded.
      const ok = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          approval_binding: decision.approval_binding,
        }),
        ctx: { ...ctx1, offline: false },
      });
      expect(ok).toBeUndefined();

      // A new conversation must not inherit the grant.
      const ctx2 = makeCtx({ services: ctx1.services, workspace_cwd: dir, conversation_id: 'conv-2' });
      const again = await classifyTier(action('exec', params), ctx2);
      expect(again.tier).toBe(3);
      expect(again.reason).toBe('tracked_executable_unapproved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D8 GAP: the oldest token is evicted at the 5000-token cap', async () => {
    const store = new InMemoryApprovalTokenStore();
    const first = await store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: {} }),
      canonical_params: {},
    });
    for (let i = 0; i < 5000; i += 1) {
      await store.mint({
        ...testApprovalOwner(),
        action_id: actionIdFor({ tool_name: 'exec', canonical_params: { i } }),
        canonical_params: { i },
      });
    }
    expect(await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: first.token_id })).toBeUndefined();
  });
});

describe('Suite E - tracked executable evasions', () => {
  test('E1 GAP: a symlinked tracked script is identified by realpath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n');
      symlinkSync(script, join(dir, 'link.sh'));
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);
      const decision = await classifyTier(action('exec', { command: 'sh link.sh', cwd: dir }), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('tracked_executable_unapproved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('E2 GAP: a copied tracked script gets a content binding, so a post-approval rewrite is detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho benign\n');
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);

      // A copy is a new identity: untracked, so no approval binding...
      const copy = join(dir, 'tool2.sh');
      copyFileSync(script, copy);
      const params = { command: `sh ${copy}`, cwd: dir };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.approval_binding).toBeNull();
      // ...but the Tier 3 shell binding still pins the copy's content hash,
      // so a rewrite after approval is detected at dispatch.
      const binding = requireShellBinding(decision);
      expect(Object.keys(binding.file_hashes).length).toBeGreaterThan(0);

      // Attacker rewrites the copy after the user approves.
      writeFileSync(copy, '#!/bin/sh\necho pwned\n');

      const result = await verifyPreDispatch({
        call: verifiableCall({
          canonical_params: params,
          tier: 3,
          approval_token_id: decision.approval_token_id,
          shell_binding: binding,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toMatch(/changed|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('E3 GUARD: `sh -c` inline code is Tier 3', async () => {
    const decision = await classifyTier(action('exec', { command: 'sh -c "echo hi"' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('shell_not_allowlisted');
  });

  test('E4 GAP: relative-path tracked script is matched after cwd resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n');
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);
      const decision = await classifyTier(action('exec', { command: './tool.sh', cwd: dir }), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('tracked_executable_unapproved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('E5 GAP: `sh -- tool.sh` does not bypass the tracked-script check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-adv-'));
    try {
      const script = join(dir, 'tool.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n');
      const ctx = makeCtx({ workspace_cwd: dir });
      trackScript(ctx, script);
      const decision = await classifyTier(action('exec', { command: 'sh -- tool.sh', cwd: dir }), ctx);
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('tracked_executable_unapproved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Suite F - tier boundary probes', () => {
  test('F1 GUARD: network access via curl is Tier 3 with a user-facing card', async () => {
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
  });

  test('F2 GUARD: missing binary on the allowlist entry is Tier 3, exact version call is Tier 1', async () => {
    const { services, cleanup } = servicesWithSeededTools();
    try {
      const ctx = makeCtx({ services, workspace_cwd: tmpdir() });
      const noBin = await classifyTier(action('exec', { command: 'node script.js' }), ctx);
      expect(noBin.tier).toBe(3);
      const withBin = await classifyTier(action('exec', { command: 'node --version' }), ctx);
      expect(withBin.tier).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('F3 GUARD: `git status` is Tier 1, config-injection forms are Tier 3', async () => {
    const { services, cleanup } = servicesWithSeededTools();
    try {
      const ctx = makeCtx({ services, workspace_cwd: tmpdir() });
      expect((await classifyTier(action('exec', { command: 'git --config user.x y' }), ctx)).tier).toBe(3);
      expect((await classifyTier(action('exec', { command: 'git -c user.x=y status' }), ctx)).tier).toBe(3);
      expect((await classifyTier(action('exec', { command: 'git status' }), ctx)).tier).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('F3b GAP: git subcommands outside the read-only list are Tier 3', async () => {
    const { services, cleanup } = servicesWithSeededTools();
    try {
      const ctx = makeCtx({ services, workspace_cwd: tmpdir() });
      const bypasses = [
        'git push origin main',
        'git pull',
        'git fetch',
        'git remote add origin https://example.com/r.git',
        "git config core.fsmonitor 'sh x.sh'",
        "git config alias.x '!sh x.sh'",
        'git x',
        "git -c alias.x='!sh x.sh' x",
        'git --exec-path=. status',
        'git -C . status',
        'git branch newbranch',
      ];
      for (const command of bypasses) {
        expect((await classifyTier(action('exec', { command }), ctx)).tier).toBe(3);
      }
      for (const command of ['git status', 'git log --oneline -n 5', 'git diff --cached', 'git branch --list']) {
        expect((await classifyTier(action('exec', { command }), ctx)).tier).toBe(1);
      }
    } finally {
      cleanup();
    }
  });

  test('F4 GUARD: `python3 -c` inline code is Tier 3', async () => {
    const { services, cleanup } = servicesWithSeededTools();
    try {
      const decision = await classifyTier(action('exec', { command: 'python3 -c "print(1)"' }), makeCtx({ services }));
      expect(decision.tier).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('F5 GUARD: runner workflows are Tier 3 regardless of name', async () => {
    for (const workflow of ['test', 'lint', 'typecheck', 'build']) {
      const decision = await classifyTier(action('run_workflow', { workflow }), makeCtx());
      expect(decision.tier).toBe(3);
    }
    const registered = await classifyTier(action('run_registered_command', { command_id: 'deploy' }), makeCtx());
    expect(registered.tier).toBe(3);
  });
});

describe('Suite G - dispatch time-of-check', () => {
  test('G1 GAP: repointing a symlinked parent between classification and dispatch fails closed', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sentinel-out-'));
    try {
      const sub = join(ws, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, 'notes.txt'), 'hello');
      symlinkSync(sub, join(ws, 'linkdir'));
      const ctx = makeCtx({ workspace_cwd: ws });
      const params = { command: 'write_file', path: 'linkdir/evil.txt' };
      const decision = await classifyTier(action('write_file', { path: 'linkdir/evil.txt', content: 'x' }), ctx);
      expect(decision.tier).toBe(2); // classified while the link pointed inside

      rmSync(join(ws, 'linkdir'));
      symlinkSync(outside, join(ws, 'linkdir')); // repointed outside after classification

      const result = await verifyPreDispatch({
        call: verifiableCall({ tool_name: 'write_file', canonical_params: params, tier: 2 }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).not.toBeUndefined();
      expect(result).toMatch(/outside the workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('G1 GUARD: Tier 2 write dispatch passes for a new file when nothing changed', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const ctx = makeCtx({ workspace_cwd: ws });
      const decision = await classifyTier(action('write_file', { path: 'new.txt', content: 'x' }), ctx);
      expect(decision.tier).toBe(2);

      const result = await verifyPreDispatch({
        call: verifiableCall({
          tool_name: 'write_file',
          canonical_params: { path: 'new.txt', content: 'x' },
          tier: 2,
        }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('G2 GAP: repointing a symlinked parent for a silent shell operand fails closed at dispatch', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'sentinel-out-'));
    const { services, cleanup } = servicesWithCatAllowlist();
    try {
      const sub = join(ws, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, 'notes.txt'), 'hello');
      symlinkSync(sub, join(ws, 'linkdir'));
      const ctx = makeCtx({ services, workspace_cwd: ws });
      const params = { command: 'cat linkdir/notes.txt', cwd: ws };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(1); // classified while the link pointed inside

      rmSync(join(ws, 'linkdir'));
      symlinkSync(outside, join(ws, 'linkdir')); // repointed outside after classification

      const result = await verifyPreDispatch({
        call: verifiableCall({ canonical_params: params, tier: 1 }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).not.toBeUndefined();
      expect(result).toMatch(/outside the workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  test('G2 GUARD: silent shell dispatch passes when nothing changed', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    const { services, cleanup } = servicesWithCatAllowlist();
    try {
      writeFileSync(join(ws, 'notes.txt'), 'hello');
      const ctx = makeCtx({ services, workspace_cwd: ws });
      const params = { command: 'cat notes.txt', cwd: ws };
      const decision = await classifyTier(action('exec', params), ctx);
      expect(decision.tier).toBe(1);

      const result = await verifyPreDispatch({
        call: verifiableCall({ canonical_params: params, tier: 1 }),
        ctx: { ...ctx, offline: false },
      });
      expect(result).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      cleanup();
    }
  });
});
