import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionIdFor, normalizeCwd } from '../../../src/core/permissions/approvalTokens';
import {
  canonicalShellForm,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { type ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';
import {
  canonicalFileIdentity,
  canonicalWriteTarget,
  isInsideWorkspace,
  lexicalPath,
  sha256FileContent,
  type PathResolution,
} from '../../../src/core/permissions/trackedExecutables';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { testApprovalOwner } from './approvalTokenFixtures';

/** A sandbox whose files the server cannot see: nothing at /workspace exists on this machine. */
const REMOTE_ROOT = '/workspace';

function servicesWithAllowlist(binDir: string): SentinelServices {
  writeFileSync(join(binDir, 'ls'), '#!/bin/sh\n');
  const shell_allowlist: ShellAllowlistConfig = {
    pinned_path: binDir,
    commands: {
      ls: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, script: null, subcommands: null },
    },
  };
  const services = defaultSentinelServices({ pinned_path: binDir });
  services.shell_allowlist = shell_allowlist;
  return services;
}

function ctxFor(input: {
  services: SentinelServices;
  root: string;
  resolution: PathResolution | undefined;
}): ClassifyContext {
  return {
    services: input.services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: input.root,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: input.resolution,
  };
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

describe('a remote sandbox reads paths lexically', () => {
  test('normalizes POSIX paths against an absolute cwd and refuses what it cannot read', () => {
    expect(lexicalPath({ p: 'a/./b/../c', cwd: '/workspace/x' })).toBe('/workspace/x/a/c');
    expect(lexicalPath({ p: '/workspace//y/', cwd: '/anywhere' })).toBe('/workspace/y');
    expect(lexicalPath({ p: '../../../../etc', cwd: '/workspace' })).toBe('/etc');
    expect(lexicalPath({ p: 'a\0b', cwd: '/workspace' })).toBeNull();
    expect(lexicalPath({ p: 'a', cwd: 'relative' })).toBeNull();
  });

  test('inside means under the workspace by whole components', () => {
    const inside = (p: string, cwd = REMOTE_ROOT): boolean =>
      isInsideWorkspace({ p, cwd, workspace_root: REMOTE_ROOT, resolution: 'remote' });
    expect(inside('a/b.txt')).toBe(true);
    expect(inside('.')).toBe(true);
    expect(inside('sub/../a')).toBe(true);
    expect(inside('../etc/passwd')).toBe(false);
    expect(inside('/workspace/../etc')).toBe(false);
    expect(inside('/workspace-evil/x')).toBe(false);
    expect(inside('/etc/passwd')).toBe(false);
    expect(inside('a', '/tmp')).toBe(false);
    expect(inside('a\0b')).toBe(false);
  });

  test('never reads the server: file contents are not available, and a same-named server file does not stand in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-fs-'));
    try {
      const file = join(dir, 'real.txt');
      writeFileSync(file, 'host bytes');
      expect(sha256FileContent(file)).not.toBeNull();
      expect(sha256FileContent(file, 'remote')).toBeNull();
      expect(canonicalFileIdentity({ p: file, cwd: '/', resolution: 'remote' })).toBe(file);
      expect(canonicalWriteTarget({ p: '/workspace/not/yet/here.txt', cwd: '/', resolution: 'remote' })).toBe(
        '/workspace/not/yet/here.txt',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cwd normalization is the same text at mint and at dispatch', () => {
    const a = normalizeCwd({ cwd: '/workspace/./x/../y', workspace_root: REMOTE_ROOT, resolution: 'remote' });
    const b = normalizeCwd({ cwd: 'y', workspace_root: REMOTE_ROOT, resolution: 'remote' });
    expect(a).toBe('/workspace/y');
    expect(b).toBe(a);
    expect(normalizeCwd({ cwd: undefined, workspace_root: REMOTE_ROOT, resolution: 'remote' })).toBe(REMOTE_ROOT);
  });
});

describe('the same call gets the same tier on a host workspace and on a remote one', () => {
  let hostDir: string;
  let binDir: string;
  let services: SentinelServices;

  beforeAll(() => {
    hostDir = mkdtempSync(join(tmpdir(), 'tier-host-'));
    binDir = mkdtempSync(join(tmpdir(), 'tier-bin-'));
    mkdirSync(join(hostDir, 'sub'));
    services = servicesWithAllowlist(binDir);
  });

  afterAll(() => {
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  /** Classifies one call on both kinds of workspace; `at` writes a path relative to the workspace root. */
  async function both(build: (root: string) => SentinelAction): Promise<{ host: string; remote: string }> {
    const host = await classifyTier(build(hostDir), ctxFor({ services, root: hostDir, resolution: undefined }));
    const remote = await classifyTier(
      build(REMOTE_ROOT),
      ctxFor({ services, root: REMOTE_ROOT, resolution: 'remote' }),
    );
    return { host: `${String(host.tier)}:${host.reason}`, remote: `${String(remote.tier)}:${remote.reason}` };
  }

  test.each([
    ['a new file in the workspace', (r: string) => action('write_file', { path: `${r}/notes.md`, content: 'x' })],
    ['a file in a subdirectory', (r: string) => action('write_file', { path: `${r}/sub/a.txt`, content: 'x' })],
    [
      'a relative path under the cwd',
      (r: string) => action('write_file', { path: 'a.txt', cwd: `${r}/sub`, content: 'x' }),
    ],
    [
      'a path that climbs out with ..',
      (r: string) => action('write_file', { path: `${r}/../escape.txt`, content: 'x' }),
    ],
    [
      'a relative path that climbs out',
      (r: string) => action('write_file', { path: '../../x', cwd: `${r}/sub`, content: 'x' }),
    ],
    ['an absolute path outside', (r: string) => action('write_file', { path: '/etc/cron.d/x', content: `x${r}` })],
    ['an allowlisted command in the workspace', (r: string) => action('exec', { command: 'ls -l', cwd: r })],
    ['an allowlisted command in a subdirectory', (r: string) => action('exec', { command: 'ls -l sub', cwd: r })],
    [
      'an allowlisted command with a cwd outside',
      (r: string) => action('exec', { command: 'ls -l', cwd: `${r}/../..` }),
    ],
    [
      'an allowlisted command with an operand that climbs out',
      (r: string) => action('exec', { command: 'ls -l ../x', cwd: r }),
    ],
    [
      'an allowlisted command with an absolute operand outside',
      (r: string) => action('exec', { command: 'ls -l /etc', cwd: r }),
    ],
    ['a network command', (r: string) => action('exec', { command: 'curl https://example.com', cwd: r })],
  ])('%s', async (_name, build) => {
    const { host, remote } = await both(build);
    expect(remote).toBe(host);
  });

  // A path whose parent does not exist cannot be resolved on the host and is asked about for that reason; the
  // remote mode reads the name itself. The tier is the same.
  test.each([
    ['a git control file', (r: string) => action('write_file', { path: `${r}/.git/hooks/pre-commit`, content: 'x' })],
    ['a command that is not allowlisted', (r: string) => action('exec', { command: 'python3 main.py', cwd: r })],
  ])('%s asks on both', async (_name, build) => {
    const { host, remote } = await both(build);
    expect(remote.split(':')[0]).toBe(host.split(':')[0]);
    expect(remote.startsWith('3:')).toBe(true);
  });

  test('the inside calls are not merely equal but the usual ones: a write asks as Tier 2, an allowlisted read is silent', async () => {
    const write = await both(r => action('write_file', { path: `${r}/notes.md`, content: 'x' }));
    expect(write.remote).toBe('2:sandbox_write');
    const list = await both(r => action('exec', { command: 'ls -l', cwd: r }));
    expect(list.remote).toBe('1:shell_allowlist');
  });

  test('escapes and unreadable paths ask instead of running', async () => {
    const outside = await both(r => action('write_file', { path: `${r}/../x`, content: 'x' }));
    expect(outside.remote).toBe('3:write_outside_workspace');
    const nul = await both(r => action('write_file', { path: `${r}/a\0b`, content: 'x' }));
    expect(nul.remote).toBe('3:write_outside_workspace');
    const cwdOut = await both(r => action('exec', { command: 'ls -l', cwd: `${r}/../etc` }));
    expect(cwdOut.remote).toBe('3:cwd_outside_workspace');
  });

  test('a symlink is only a name to the server: the host resolves it, the remote mode does not', async () => {
    const link = join(hostDir, 'link-out');
    symlinkSync('/etc', link);
    const onHost = await classifyTier(
      action('write_file', { path: join(link, 'x'), content: 'x' }),
      ctxFor({ services, root: hostDir, resolution: undefined }),
    );
    expect(onHost.reason).toBe('write_outside_workspace');
    const remote = await classifyTier(
      action('write_file', { path: `${REMOTE_ROOT}/link-out/x`, content: 'x' }),
      ctxFor({ services, root: REMOTE_ROOT, resolution: 'remote' }),
    );
    expect(remote.tier).toBe(2);
  });

  test('a host workspace is unchanged when no mode is given and is not read lexically', async () => {
    const missing = await classifyTier(
      action('write_file', { path: '/workspace/a.txt', content: 'x' }),
      ctxFor({ services, root: REMOTE_ROOT, resolution: undefined }),
    );
    expect(missing.reason).toBe('write_outside_workspace');
    const explicitHost = await classifyTier(
      action('write_file', { path: '/workspace/a.txt', content: 'x' }),
      ctxFor({ services, root: REMOTE_ROOT, resolution: 'host' }),
    );
    expect(explicitHost.reason).toBe('write_outside_workspace');
  });
});

describe('approvals bind to the normalized path', () => {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });

  test('two spellings of one command give one canonical form, and a different directory does not', () => {
    const form = (command: string, cwd: string) =>
      canonicalShellForm({
        command,
        cwd,
        env: null,
        allowlist: services.shell_allowlist,
        workspace_cwd: REMOTE_ROOT,
        path_resolution: 'remote',
      });
    const a = form('python3 sub/../tool.py', '/workspace/./a');
    const b = form('python3 sub/../tool.py', '/workspace/a');
    expect(actionIdFor({ tool_name: 'exec', canonical_params: a })).toBe(
      actionIdFor({ tool_name: 'exec', canonical_params: b }),
    );
    expect(a.cwd_resolved).toBe('/workspace/a');
    expect(form('python3 tool.py', '/workspace/b').cwd_resolved).toBe('/workspace/b');
    expect(Object.keys(a.file_hashes)).toEqual([]);
  });

  async function approvedWrite(path: string): Promise<{ params: Record<string, unknown>; tokenId: string }> {
    const params = { path, content: 'x' };
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'write_file', canonical_params: params }),
      canonical_params: params,
    });
    return { params, tokenId: token.token_id };
  }

  const dispatchCtx = { ...ctxFor({ services, root: REMOTE_ROOT, resolution: 'remote' }), offline: false };

  test('a card approved for one path cannot run against another, and an escape fails the containment re-check', async () => {
    const { params, tokenId } = await approvedWrite('/workspace/a.txt');
    const call = {
      tool_name: 'write_file',
      tool_type: 'truefoundry-system' as const,
      canonical_params: params,
      tier: 2 as const,
      approval_token_id: tokenId,
      approval_binding: null,
      shell_binding: null,
    };
    const changed = await verifyPreDispatch({
      call: { ...call, canonical_params: { ...params, path: '/workspace/b.txt' } },
      ctx: dispatchCtx,
    });
    expect(changed).toMatch(/changed since approval/i);
    const { params: escape, tokenId: escapeToken } = await approvedWrite('/workspace/../etc/x');
    const escaped = await verifyPreDispatch({
      call: { ...call, canonical_params: escape, approval_token_id: escapeToken },
      ctx: dispatchCtx,
    });
    expect(escaped).toMatch(/outside the workspace/i);
    const fresh = await approvedWrite('/workspace/a.txt');
    expect(
      await verifyPreDispatch({
        call: { ...call, canonical_params: fresh.params, approval_token_id: fresh.tokenId },
        ctx: dispatchCtx,
      }),
    ).toBeUndefined();
  });

  test('a script the agent wrote asks every time, and the approval is for that normalized path only', async () => {
    const ctx = ctxFor({ services, root: REMOTE_ROOT, resolution: 'remote' });
    services.tracked_store.track({
      scope: {
        tenant_id: ctx.tenant_id,
        created_by: ctx.created_by,
        conversation_id: ctx.conversation_id,
        repository_id: null,
        workspace_cwd: REMOTE_ROOT,
      },
      file_identity: '/workspace/tool.sh',
    });
    const classify = async (command: string) => {
      const decision = await classifyTier(action('exec', { command, cwd: REMOTE_ROOT }), ctx);
      const { approval_binding: binding, approval_token_id: tokenId } = decision;
      if (binding === null || binding === undefined || tokenId === null || tokenId === undefined) {
        throw new Error('expected a tracked-execution approval');
      }
      return { decision, binding, tokenId };
    };
    const base = {
      tool_name: 'exec',
      tool_type: 'truefoundry-system' as const,
      tier: 3 as const,
      shell_binding: null,
    };
    const first = await classify('sh sub/../tool.sh');
    expect(first.decision.reason).toBe('tracked_executable_unapproved');
    expect(first.binding.file_identity).toBe('/workspace/tool.sh');
    const moved = await verifyPreDispatch({
      call: {
        ...base,
        approval_binding: first.binding,
        approval_token_id: first.tokenId,
        canonical_params: { command: 'sh other.sh', cwd: REMOTE_ROOT },
      },
      ctx: { ...ctx, offline: false },
    });
    expect(moved).toMatch(/invalid/i);
    const second = await classify('sh sub/../tool.sh');
    const approved = await verifyPreDispatch({
      call: {
        ...base,
        approval_binding: second.binding,
        approval_token_id: second.tokenId,
        canonical_params: { command: 'sh sub/../tool.sh', cwd: REMOTE_ROOT },
      },
      ctx: { ...ctx, offline: false },
    });
    expect(approved).toBeUndefined();
    // No grant is kept, because the server cannot read the file to bind its content.
    expect((await classify('sh sub/../tool.sh')).decision.reason).toBe('tracked_executable_unapproved');
  });
});

describe('approvals bind to file content in a remote sandbox when the sandbox can be read', () => {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const files = new Map<string, string>([['/workspace/tool.sh', 'digest-one']]);
  const read = (path: string): Promise<string | null> => Promise.resolve(files.get(path) ?? null);
  const ctx: ClassifyContext = { ...ctxFor({ services, root: REMOTE_ROOT, resolution: 'remote' }), file_digest: read };

  beforeAll(() => {
    services.tracked_store.track({
      scope: {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'c1',
        repository_id: null,
        workspace_cwd: REMOTE_ROOT,
      },
      file_identity: '/workspace/tool.sh',
    });
  });

  async function ask(command: string) {
    const decision = await classifyTier(action('exec', { command, cwd: REMOTE_ROOT }), ctx);
    return decision;
  }

  function callFor(decision: Awaited<ReturnType<typeof ask>>, command: string) {
    return {
      tool_name: 'exec',
      tool_type: 'truefoundry-system' as const,
      canonical_params: { command, cwd: REMOTE_ROOT },
      tier: 3 as const,
      approval_token_id: decision.approval_token_id ?? null,
      approval_binding: decision.approval_binding ?? null,
      shell_binding: decision.shell_binding ?? null,
    };
  }

  test('a script that changed since approval is refused, and an unchanged one is remembered', async () => {
    const first = await ask('sh tool.sh');
    expect(first.approval_binding?.content_hash).toBe('digest-one');
    files.set('/workspace/tool.sh', 'digest-two');
    const changed = await verifyPreDispatch({
      call: callFor(first, 'sh tool.sh'),
      ctx: { ...ctx, offline: false },
    });
    expect(changed).toMatch(/invalid/i);
    files.set('/workspace/tool.sh', 'digest-one');
    const second = await ask('sh tool.sh');
    expect(
      await verifyPreDispatch({ call: callFor(second, 'sh tool.sh'), ctx: { ...ctx, offline: false } }),
    ).toBeUndefined();
    // The byte-identical re-run is now remembered, as on the server's own filesystem.
    expect((await ask('sh tool.sh')).reason).not.toBe('tracked_executable_unapproved');
  });

  test('a command that runs a file binds to that file, so editing it after approval voids the approval', async () => {
    files.set('/workspace/job.py', 'job-one');
    const decision = await ask('python3 job.py');
    expect(decision.tier).toBe(3);
    expect(decision.shell_binding?.file_hashes).toMatchObject({ '/workspace/job.py': 'job-one' });
    files.set('/workspace/job.py', 'job-two');
    const result = await verifyPreDispatch({
      call: callFor(decision, 'python3 job.py'),
      ctx: { ...ctx, offline: false },
    });
    expect(result).toMatch(/changed since approval/i);
  });
});
