import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ShellApprovalBindingSchema,
  type ShellApprovalBinding,
} from '../../../src/core/permissions/approvalTokens';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch, type VerifiableCall } from '../../../src/core/permissions/dispatch';
import type { TierDecision } from '../../../src/core/permissions/tier';
import type { PathResolution } from '../../../src/core/permissions/trackedExecutables';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** The sandbox workspace root as the server spells it; nothing exists there on this machine. */
const REMOTE_ROOT = '/workspace';

/** The command from the original failure: approved with the sandbox off, refused once it was on. */
const CLONE_COMMAND = 'git clone --branch main https://github.com/ClimbOutLabs/exitramp.git exitramp';

function makeCtx(input: {
  services: SentinelServices;
  workspace_cwd: string | null;
  path_resolution?: PathResolution | undefined;
  file_digest?: ClassifyContext['file_digest'];
}): ClassifyContext {
  return {
    services: input.services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: input.workspace_cwd,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: input.path_resolution,
    file_digest: input.file_digest,
  };
}

/** The classify-time view with the sandbox off: a real folder on this machine, no path resolution in force. */
function hostCtx(services: SentinelServices, workspace: string): ClassifyContext {
  return makeCtx({ services, workspace_cwd: workspace });
}

/** The classify-time view with the sandbox on: the workspace lives behind the sandbox reader. */
function remoteCtx(services: SentinelServices): ClassifyContext {
  return makeCtx({
    services,
    workspace_cwd: REMOTE_ROOT,
    path_resolution: 'remote',
    file_digest: () => Promise.resolve(null),
  });
}

function action(canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name: 'exec', canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

function requireShellApproval(decision: TierDecision): { token_id: string; binding: ShellApprovalBinding } {
  if (decision.tier !== 3 || decision.approval_token_id === null || decision.shell_binding === null) {
    throw new Error(
      `expected a Tier 3 shell approval, got tier ${String(decision.tier)} (${decision.reason})`,
    );
  }
  return { token_id: decision.approval_token_id, binding: decision.shell_binding };
}

async function approve(input: {
  ctx: ClassifyContext;
  params: Record<string, unknown>;
}): Promise<{ token_id: string; binding: ShellApprovalBinding }> {
  return requireShellApproval(await classifyTier(action(input.params), input.ctx));
}

/** Dispatches an approved call under a possibly different live context than the one that approved it. */
async function dispatch(input: {
  approval: { token_id: string; binding: ShellApprovalBinding };
  params: Record<string, unknown>;
  ctx: ClassifyContext;
}): Promise<string | undefined> {
  const call: VerifiableCall = {
    tool_name: 'exec',
    tool_type: 'truefoundry-system',
    canonical_params: input.params,
    tier: 3,
    approval_token_id: input.approval.token_id,
    approval_binding: null,
    shell_binding: input.approval.binding,
  };
  return verifyPreDispatch({ call, ctx: { ...input.ctx, offline: false } });
}

describe('an approval replays the environment it was granted in', () => {
  test('approved with the sandbox off, the same command still verifies after the sandbox is enabled', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const approval = await approve({ ctx: hostCtx(services, dir), params: { command: CLONE_COMMAND } });
      expect(approval.binding.workspace_cwd).toBe(dir);
      expect(approval.binding.path_resolution).toBeNull();
      expect(approval.binding.cwd_resolved).toBe(realpathSync(dir));

      const result = await dispatch({ approval, params: { command: CLONE_COMMAND }, ctx: remoteCtx(services) });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('approved with the sandbox on, the same command still verifies after the sandbox is turned off', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const approval = await approve({ ctx: remoteCtx(services), params: { command: CLONE_COMMAND } });
      expect(approval.binding.workspace_cwd).toBe(REMOTE_ROOT);
      expect(approval.binding.path_resolution).toBe('remote');
      expect(approval.binding.cwd_resolved).toBe(REMOTE_ROOT);

      const result = await dispatch({ approval, params: { command: CLONE_COMMAND }, ctx: hostCtx(services, dir) });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a changed command is still refused across the same flip', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const approval = await approve({ ctx: hostCtx(services, dir), params: { command: CLONE_COMMAND } });
      const changed = 'git clone --branch main https://github.com/ClimbOutLabs/exitramp.git otherdir';
      const result = await dispatch({ approval, params: { command: changed }, ctx: remoteCtx(services) });
      expect(result).toBe('Approval invalid: action identity changed since approval; request approval again.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a changed command is still refused across the reverse flip', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const approval = await approve({ ctx: remoteCtx(services), params: { command: CLONE_COMMAND } });
      const changed = 'git clone --branch dev https://github.com/ClimbOutLabs/exitramp.git exitramp';
      const result = await dispatch({ approval, params: { command: changed }, ctx: hostCtx(services, dir) });
      expect(result).toBe('Approval invalid: action identity changed since approval; request approval again.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a changed working directory is still refused across the flip', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const params = { command: CLONE_COMMAND, cwd: dir };
      const approval = await approve({ ctx: hostCtx(services, dir), params });
      const result = await dispatch({
        approval,
        params: { command: CLONE_COMMAND, cwd: join(dir, 'elsewhere') },
        ctx: remoteCtx(services),
      });
      expect(result).toMatch(/changed since approval/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changed environment overrides are still refused across the flip', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const params = { command: CLONE_COMMAND, env: { GIT_TRACE: '0' } };
      const approval = await approve({ ctx: hostCtx(services, dir), params });
      const result = await dispatch({
        approval,
        params: { command: CLONE_COMMAND, env: { GIT_TRACE: '1' } },
        ctx: remoteCtx(services),
      });
      expect(result).toMatch(/changed since approval/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bound file verifies unchanged across the flip and is refused once its contents change', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const script = join(dir, 'job.py');
      writeFileSync(script, 'print("one")\n');
      const params = { command: 'python3 job.py' };

      const unchanged = await approve({ ctx: hostCtx(services, dir), params });
      expect(Object.keys(unchanged.binding.file_hashes)).toEqual([join(realpathSync(dir), 'job.py')]);
      expect(await dispatch({ approval: unchanged, params, ctx: remoteCtx(services) })).toBeUndefined();

      const edited = await approve({ ctx: hostCtx(services, dir), params });
      writeFileSync(script, 'print("two")\n');
      const result = await dispatch({ approval: edited, params, ctx: remoteCtx(services) });
      expect(result).toMatch(/changed since approval/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a binding saved before the environment was stamped keeps the old behaviour in its own environment', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const dir = mkdtempSync(join(tmpdir(), 'replay-host-'));
    try {
      const approval = await approve({ ctx: hostCtx(services, dir), params: { command: CLONE_COMMAND } });
      // The shape older saved approvals carry: no environment stamp at all.
      const legacy = ShellApprovalBindingSchema.parse({
        commands: approval.binding.commands,
        redirections: approval.binding.redirections,
        cwd_resolved: approval.binding.cwd_resolved,
        env_overrides: approval.binding.env_overrides,
        file_hashes: approval.binding.file_hashes,
      });
      expect(legacy.workspace_cwd).toBeNull();
      expect(legacy.path_resolution).toBeNull();

      const same = await dispatch({
        approval: { token_id: approval.token_id, binding: legacy },
        params: { command: CLONE_COMMAND },
        ctx: hostCtx(services, dir),
      });
      expect(same).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
