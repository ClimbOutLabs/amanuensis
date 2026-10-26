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
import { FIRST_PARTY_TOOL_REASON, isStandingTrustDecision } from '../../../src/core/permissions/connectorTrust';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
  withoutRelaxations,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { recordPersonText, recordUntrustedText } from '../../../src/core/permissions/provenance';
import { seedShellAllowlist, type ShellAllowlistConfig } from '../../../src/core/permissions/shellAllowlist';
import type { Tier2ActionKind } from '../../../src/core/permissions/tier';
import { TOOL_GRANT_REASON, type ToolGrantKey, type ToolGrantStore } from '../../../src/core/permissions/toolGrants';
import { createWebSearchTurnState, SEARCH_STEERED_REASON } from '../../../src/core/permissions/webSearch';
import { TEST_TOKEN_SCOPE, testApprovalOwner } from './approvalTokenFixtures';

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
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, script: null, subcommands: null },
      ls: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, script: null, subcommands: null },
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
    web_search: createWebSearchTurnState(),
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
      const decision = await classifyTier(
        action('exec', { command: 'mycmd -l' }),
        makeCtx({ services, workspace_cwd: tmpdir() }),
      );
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
      const allowed = await classifyTier(
        action('exec', { command: 'ls' }),
        makeCtx({ services, workspace_cwd: tmpdir() }),
      );
      expect(allowed.tier).toBe(1);
      expect(allowed.auto_deny).toBeNull();
      const denied = await classifyTier(
        action('exec', { command: 'mycmd -l' }),
        makeCtx({ services, workspace_cwd: tmpdir() }),
      );
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
      const unattended = forUnattendedRun(
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

  test('an attended turn in a scheduled chat still asks for a file write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const attended = withoutRelaxations(
        relaxing(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ['file_write']),
      );
      expect(attended.unattended).toBe(false);
      const decision = await classifyTier(
        action('write_file', { path: join(dir, 'notes.md'), content: 'x' }),
        makeCtx({ services: attended, workspace_cwd: dir }),
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
        makeCtx({ services: forUnattendedRun(services), workspace_cwd: workspace }),
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

  test.each([
    ['cat environ', '/proc/self'],
    ['cat passwd', '/etc'],
    ['ls', '/'],
  ])('with no workspace, %s in %s asks instead of running silently', async (command, cwd) => {
    const { services, cleanup } = seededWorkspace();
    try {
      const decision = await classifyTier(action('exec', { command, cwd }), makeCtx({ services, workspace_cwd: null }));
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('workspace_unknown');
      expect(decision.card).not.toBeNull();
      expect(decision.approval_token_id).not.toBeNull();
      expect(decision.shell_binding).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('with no workspace, offline mode asks too', async () => {
    const { services, cleanup } = seededWorkspace();
    services.isOffline = () => Promise.resolve(true);
    try {
      const decision = await classifyTier(
        action('exec', { command: 'cat passwd', cwd: '/etc' }),
        makeCtx({ services, workspace_cwd: null }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('workspace_unknown');
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

describe('classifyTier exec reaching the internet', () => {
  const internetNote = 'This command tries to reach the internet.';

  test('the card says so in plain words when the host flagged the command as open-world', async () => {
    const flagged: SentinelAction = {
      ...action('exec', { command: 'curl https://example.com' }),
      mcp_hints: { open_world_hint: true },
    };
    const decision = await classifyTier(flagged, makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toContain(internetNote);
  });

  test('an unflagged command keeps its card wording', async () => {
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), makeCtx());
    expect(decision.card?.plain_what).not.toContain(internetNote);
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
        scope: {
          tenant_id: 't1',
          created_by: 'u1',
          conversation_id: 'conv-1',
          repository_id: 'r1',
          workspace_cwd: dir,
        },
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
  /** Grant identity to the connector host it was recorded for. */
  private readonly grants = new Map<string, string | null>();

  private static id(key: ToolGrantKey): string {
    return JSON.stringify([key.tenant_id, key.created_by, key.mcp_server_name, key.tool_name]);
  }

  hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    const id = RevocableGrantStore.id(key);
    return Promise.resolve(this.grants.has(id) && this.grants.get(id) === key.mcp_server_host);
  }

  recordToolGrant(key: ToolGrantKey): Promise<void> {
    this.grants.set(RevocableGrantStore.id(key), key.mcp_server_host);
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
    mcp_server_host: null,
  };

  function connectorAction(input?: {
    tool_name?: string;
    mcp_server_name?: string;
    mcp_server_host?: string | null;
    mcp_hints?: SentinelAction['mcp_hints'];
    canonical_params?: Record<string, unknown>;
  }): SentinelAction {
    return {
      tool_name: input?.tool_name ?? grantKey.tool_name,
      canonical_params: input?.canonical_params ?? { id: '1' },
      tool_type: 'mcp',
      mcp_server_name: input?.mcp_server_name ?? grantKey.mcp_server_name,
      ...(input?.mcp_server_host == null ? {} : { mcp_server_host: input.mcp_server_host }),
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

  test('a grant binds to the connector host: the same tool on a connector that now points elsewhere asks again', async () => {
    const bound = { ...grantKey, mcp_server_host: 'mail.example.com' };
    const { services } = grantedServices([bound]);

    const sameHost = await classifyTier(
      connectorAction({ mcp_server_host: 'mail.example.com' }),
      makeCtx({ services }),
    );
    expect(sameHost.tier).toBe(1);
    expect(sameHost.reason).toBe(TOOL_GRANT_REASON);

    const moved = await classifyTier(connectorAction({ mcp_server_host: 'other.example.com' }), makeCtx({ services }));
    expect(moved.tier).toBe(3);
    expect(moved.card).not.toBeNull();
  });

  test('a grant made for a connector with no URL does not cover one that has a host, and the reverse', async () => {
    const { services: noHost } = grantedServices([{ ...grantKey, mcp_server_host: null }]);
    const gained = await classifyTier(
      connectorAction({ mcp_server_host: 'mail.example.com' }),
      makeCtx({ services: noHost }),
    );
    expect(gained.tier).toBe(3);

    const { services: hosted } = grantedServices([{ ...grantKey, mcp_server_host: 'mail.example.com' }]);
    const lost = await classifyTier(connectorAction(), makeCtx({ services: hosted }));
    expect(lost.tier).toBe(3);
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

  test.each([
    ['a very long path ending in an SSH key', { path: `${'/a'.repeat(4000)}/.ssh/id_rsa` }],
    ['a bare credentials name under a path key', { path: 'credentials' }],
    ['a credentials backup under a path key', { path: 'credentials.backup.json' }],
    ['a Windows path to an SSH key', { path: 'C:\\Users\\u\\.ssh\\id_rsa' }],
    ['a git credentials file', { path: '/home/u/.git-credentials' }],
    ['a client secret file', { path: '/home/u/client_secret.json' }],
    ['an application default credentials file', { path: '/home/u/application_default_credentials.json' }],
    ['a token text file', { path: '/home/u/github_token.txt' }],
  ])('a granted tool still asks for %s', async (_, canonical_params) => {
    const { services } = grantedServices();
    const decision = await classifyTier(connectorAction({ canonical_params }), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.sensitive_read).toBe(true);
    expect(decision.secret_path_read).toBe(true);
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
  });

  test.each([
    ['a search with a secret word in free text', { query: 'my token budget and secret santa plans' }],
    ['a message id', { id: '18f2a9c0' }],
  ])('a granted tool still runs silently for %s', async (_, canonical_params) => {
    const { services } = grantedServices();
    const decision = await classifyTier(connectorAction({ canonical_params }), makeCtx({ services }));
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe(TOOL_GRANT_REASON);
  });

  test.each([
    ['a file in a folder named secretary', { path: '/work/secretary/notes.md' }],
    ['a file named tokenizer', { path: '/repo/src/tokenizer.ts' }],
    ['a file in a folder named keyboard', { path: '/work/keyboard/layout.md' }],
    ['a file with an extension and no folder', { file: 'layout.md' }],
    ['a Windows path', { path: 'C:\\Users\\u\\notes\\plan.txt' }],
    ['a parent folder reference', { path: '..' }],
    ['a dotfile name', { path: '.bashrc' }],
    ['a percent-encoded parent path', { path: '..%2F..%2F.ssh%2Fid_rsa' }],
    ['a double-encoded parent path', { path: '%252e%252e%252fsecrets' }],
    ['a division slash path', { path: 'notes\u2215todo' }],
    ['a fullwidth slash path', { path: 'notes\uFF0Ftodo' }],
    ['a path-like key', { '../secrets': 'yes' }],
  ])('a granted tool asks for a path-like argument, %s', async (_, canonical_params) => {
    const { services } = grantedServices();
    const decision = await classifyTier(connectorAction({ canonical_params }), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
    expect(decision.card).not.toBeNull();
    expect(decision.inspection).toBe(false);
    expect(decision.secret_path_read).toBe(true);
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

describe('classifyTier first-party connector tools', () => {
  const closedWorldRead: SentinelAction['mcp_hints'] = { read_only_hint: true, open_world_hint: false };

  function connectorAction(input?: {
    tool_name?: string;
    mcp_first_party?: boolean;
    mcp_hints?: SentinelAction['mcp_hints'];
    canonical_params?: Record<string, unknown>;
  }): SentinelAction {
    return {
      tool_name: input?.tool_name ?? 'ask_memory',
      canonical_params: input?.canonical_params ?? { question: 'when is the dentist appointment' },
      tool_type: 'mcp',
      mcp_server_name: 'memory',
      mcp_first_party: input?.mcp_first_party ?? true,
      mcp_hints: input?.mcp_hints ?? closedWorldRead,
    };
  }

  test('a read-only, explicitly closed-world tool runs at Tier 1 without a card', async () => {
    const decision = await classifyTier(connectorAction(), makeCtx());
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe(FIRST_PARTY_TOOL_REASON);
    expect(decision.card).toBeNull();
    expect(decision.approval_token_id).toBeNull();
    expect(isStandingTrustDecision(decision)).toBe(true);
  });

  test('the same tool on a connector that is not first-party asks', async () => {
    const decision = await classifyTier(connectorAction({ mcp_first_party: false }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
  });

  test('a connector that never says whether it is first-party asks', async () => {
    const { mcp_first_party: _omitted, ...unmarked } = connectorAction();
    const decision = await classifyTier(unmarked, makeCtx());
    expect(decision.tier).toBe(3);
  });

  test('a tool that omits openWorldHint asks, since absent means open-world', async () => {
    const decision = await classifyTier(connectorAction({ mcp_hints: { read_only_hint: true } }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  test('a tool that claims to reach the open world asks', async () => {
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { read_only_hint: true, open_world_hint: true } }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  test('a tool that does not claim to be read-only asks, annotated or not', async () => {
    const writes = await classifyTier(
      connectorAction({ mcp_hints: { read_only_hint: false, open_world_hint: false } }),
      makeCtx(),
    );
    const unannotated = await classifyTier(connectorAction({ mcp_hints: {} }), makeCtx());
    expect([writes.tier, unannotated.tier]).toEqual([3, 3]);
  });

  test('a destructive hint escalates over first-party trust', async () => {
    const decision = await classifyTier(
      connectorAction({ mcp_hints: { ...closedWorldRead, destructive_hint: true } }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_destructive_hint');
  });

  test('a destructive tool name escalates over first-party trust', async () => {
    const decision = await classifyTier(connectorAction({ tool_name: 'delete_memory' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('destructive_action');
  });

  test('an install tool name escalates over first-party trust', async () => {
    const decision = await classifyTier(connectorAction({ tool_name: 'install_plugin' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('install_action');
  });

  test('an external-service action escalates over first-party trust', async () => {
    const decision = await classifyTier(
      connectorAction({ tool_name: 'send_email', canonical_params: { to: 'someone@example.com', subject: 'hi' } }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('external_service');
  });

  test('a sensitive read escalates over first-party trust', async () => {
    const decision = await classifyTier(
      connectorAction({ canonical_params: { path: '/home/someone/.ssh/id_ed25519' } }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.sensitive_read).toBe(true);
  });

  test('offline mode auto-denies a first-party tool', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.isOffline = () => Promise.resolve(true);
    const decision = await classifyTier(connectorAction(), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('offline_mode');
  });

  test('a built-in tool never reads connector trust', async () => {
    const decision = await classifyTier(
      { ...connectorAction({ mcp_hints: {} }), tool_type: 'truefoundry-system' },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  test('classifying a first-party call writes no audit entry: the run is recorded once, at dispatch', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
    };
    const sentinel = createSentinelHostContext({ tenant_id: 't1', created_by: 'u1', conversation_id: 'c1', services });

    const decision = await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: connectorAction(),
    });

    expect(decision.reason).toBe(FIRST_PARTY_TOOL_REASON);
    expect(recorded).toEqual([]);
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

  test.each([
    {
      ask: 'model-supplied environment',
      approved: (ws: string) => ({ command: 'ls', cwd: ws, env: { LD_PRELOAD: '/tmp/a.so' } }),
      changed: (ws: string) => ({ command: 'ls', cwd: ws, env: { LD_PRELOAD: '/tmp/b.so' } }),
    },
    {
      ask: 'a working directory outside the workspace',
      approved: () => ({ command: 'ls', cwd: '/' }),
      changed: () => ({ command: 'ls', cwd: '/usr' }),
    },
    {
      ask: 'an operand outside the workspace',
      approved: (ws: string) => ({ command: 'cat ../a.txt', cwd: ws }),
      changed: (ws: string) => ({ command: 'cat ../b.txt', cwd: ws }),
    },
  ])('the token for $ask binds the arguments it was minted for', async ({ approved, changed }) => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const ctx = makeCtx({ services, workspace_cwd: workspace });
      const asked = approved(workspace);
      const decision = await classifyTier(action('exec', asked), ctx);
      expect(decision.tier).toBe(3);
      const callFor = (canonical_params: Record<string, unknown>) => ({
        tool_name: 'exec',
        tool_type: 'truefoundry-system' as const,
        canonical_params,
        tier: 3 as const,
        approval_token_id: decision.approval_token_id,
        approval_binding: null,
        shell_binding: decision.shell_binding,
      });
      const verifyCtx = { ...ctx, offline: false };

      // A token minted for other arguments is rejected, and the failed try spends it.
      expect(await verifyPreDispatch({ call: callFor(changed(workspace)), ctx: verifyCtx })).toMatch(
        /changed|invalid/i,
      );
      expect(await verifyPreDispatch({ call: callFor(asked), ctx: verifyCtx })).toMatch(/already used|invalid/i);
    } finally {
      cleanup();
    }
  });

  test.each([
    {
      ask: 'model-supplied environment',
      params: (ws: string) => ({ command: 'ls', cwd: ws, env: { LD_PRELOAD: '/tmp/a.so' } }),
    },
    { ask: 'a working directory outside the workspace', params: () => ({ command: 'ls', cwd: '/' }) },
    { ask: 'an operand outside the workspace', params: (ws: string) => ({ command: 'cat ../a.txt', cwd: ws }) },
  ])('the token for $ask verifies for the same arguments exactly once', async ({ params }) => {
    const { services, workspace, cleanup } = seededWorkspace();
    try {
      const ctx = makeCtx({ services, workspace_cwd: workspace });
      const asked = params(workspace);
      const decision = await classifyTier(action('exec', asked), ctx);
      const call = {
        tool_name: 'exec',
        tool_type: 'truefoundry-system' as const,
        canonical_params: asked,
        tier: 3 as const,
        approval_token_id: decision.approval_token_id,
        approval_binding: null,
        shell_binding: decision.shell_binding,
      };
      const verifyCtx = { ...ctx, offline: false };
      expect(await verifyPreDispatch({ call, ctx: verifyCtx })).toBeUndefined();
      expect(await verifyPreDispatch({ call, ctx: verifyCtx })).toMatch(/already used|invalid/i);
    } finally {
      cleanup();
    }
  });

  test('a silent shell command is refused at dispatch when no workspace is set', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: { command: 'cat passwd', cwd: '/etc' },
        tier: 1,
        approval_token_id: null,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...makeCtx({ services, workspace_cwd: null }), offline: false },
    });
    expect(result).toMatch(/no workspace/i);
  });

  test('other silent calls still pass through without a workspace', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'read_file',
        tool_type: 'truefoundry-system',
        canonical_params: { path: 'a.txt' },
        tier: 1,
        approval_token_id: null,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: { ...makeCtx({ services, workspace_cwd: null }), offline: false },
    });
    expect(result).toBeUndefined();
  });

  test('a Tier 2 call that asked is still contained to the workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-ws-'));
    try {
      const params = { path: '/etc/passwd', content: 'x' };
      const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
      const token = await services.token_store.mint({
        ...testApprovalOwner(),
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
      expect(await services.token_store.peek({ ...TEST_TOKEN_SCOPE, token_id: token.token_id })).toBeDefined();
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
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
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
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
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
    const token = await services.token_store.mint({
      ...testApprovalOwner(),
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

describe('connector reads can be always allowed', () => {
  const mailServer = 'apple-mail';
  const readNames = [
    'list-messages',
    'search-messages',
    'get-message',
    'get-thread',
    'get-unread-count',
    'list-attachments',
    'fetch-attachment',
  ];

  function readAction(input: {
    tool_name: string;
    canonical_params?: Record<string, unknown>;
    mcp_hints?: SentinelAction['mcp_hints'];
    mcp_server_name?: string;
  }): SentinelAction {
    return {
      tool_name: input.tool_name,
      canonical_params: input.canonical_params ?? { account: 'work' },
      tool_type: 'mcp',
      mcp_server_name: input.mcp_server_name ?? mailServer,
      mcp_hints: input.mcp_hints ?? {},
    };
  }

  function grantFor(tool_name: string, mcp_server_name = mailServer): ToolGrantKey {
    return { tenant_id: 't1', created_by: 'u1', mcp_server_name, tool_name, mcp_server_host: null };
  }

  function servicesGranting(keys: ToolGrantKey[]): SentinelServices {
    const grants = new RevocableGrantStore();
    for (const key of keys) {
      void grants.recordToolGrant(key);
    }
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.tool_grants = grants;
    return services;
  }

  test.each(readNames)('%s with a standing grant runs at Tier 1 and still marks private data', async name => {
    const services = servicesGranting([grantFor(name)]);
    const decision = await classifyTier(readAction({ tool_name: name }), makeCtx({ services }));
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe(TOOL_GRANT_REASON);
    expect(decision.sensitive_read).toBe(true);
    expect(decision.inspection).toBe(true);
  });

  test.each(readNames)('%s without a grant asks with a card, as before', async name => {
    const decision = await classifyTier(readAction({ tool_name: name }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
    expect(decision.sensitive_read).toBe(true);
    expect(decision.inspection).toBe(true);
  });

  test('a scheduled run reads mail when the owner granted it', async () => {
    const services = servicesGranting([grantFor('list-messages')]);
    const decision = await classifyTier(
      readAction({ tool_name: 'list-messages' }),
      makeCtx({ services: forUnattendedRun(services) }),
    );
    expect(decision.tier).toBe(1);
  });

  test('a scheduled run holds an ungranted mail read for the owner rather than dropping it', async () => {
    const decision = await classifyTier(
      readAction({ tool_name: 'list-messages' }),
      makeCtx({ services: forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' })) }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBeNull();
    expect(decision.inspection).toBe(true);
  });

  test.each([
    ['send-email', { to: 'someone@example.com', subject: 'hi' }],
    ['reply-to-message', { id: '1', body: 'thanks' }],
    ['create-draft', { to: 'someone@example.com', subject: 'hi' }],
    ['get-message', { id: '1', to: 'someone@example.com' }],
    ['get-contacts', { id: '1' }],
  ])('%s is never always-allowed, even with a grant on it', async (name, canonical_params) => {
    const services = servicesGranting([grantFor(name)]);
    const decision = await classifyTier(readAction({ tool_name: name, canonical_params }), makeCtx({ services }));
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
    expect(decision.inspection).toBe(false);
  });

  test('a connector read of a secret path is never always-allowed, even with a grant on it', async () => {
    const services = servicesGranting([grantFor('list-messages')]);
    const decision = await classifyTier(
      readAction({ tool_name: 'list-messages', canonical_params: { account: 'work', path: '/srv/secrets/token.txt' } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
    expect(decision.inspection).toBe(false);
  });

  test.each([{ read_only_hint: true, open_world_hint: true }, { read_only_hint: false }])(
    'a mail read that claims %j is never always-allowed',
    async mcp_hints => {
      const services = servicesGranting([grantFor('list-messages')]);
      const decision = await classifyTier(readAction({ tool_name: 'list-messages', mcp_hints }), makeCtx({ services }));
      expect(decision.tier).toBe(3);
      expect(decision.inspection).toBe(false);
    },
  );

  test.each([
    ['a relative path', { attachment_path: 'notes/todo.md' }],
    ['a file name with an extension', { attachment: 'todo.md' }],
    ['a home path', { attachment_path: '~/Documents/plan' }],
    ['a drive path', { attachment_path: 'D:\\exports\\summary' }],
    ['a folder name with spaces', { attachment_path: '/home/u/My Notes/plan' }],
    ['a file name with spaces', { attachment: 'Q3 report final.pdf' }],
    ['a path nested in a list', { filters: [{ files: ['/srv/exports/2026'] }] }],
    ['a very long path', { attachment_path: `${'/a'.repeat(4000)}/draft` }],
    ['a folder that is not a zone', { attachment_path: 'America/Nowhere' }],
    ['a percent-encoded folder', { attachment_path: 'notes%2Ftodo' }],
  ])('a mail read of %s gets a card every time, even with a grant on it', async (_, args) => {
    const services = servicesGranting([grantFor('list-messages')]);
    const decision = await classifyTier(
      readAction({ tool_name: 'list-messages', canonical_params: { account: 'work', ...args } }),
      makeCtx({ services }),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.reason).not.toBe(TOOL_GRANT_REASON);
    expect(decision.sensitive_read).toBe(true);
    expect(decision.secret_path_read).toBe(true);
    expect(decision.inspection).toBe(false);
  });

  test.each([
    ['a sender search with an email address', { query: 'invoice from:alice@example.com' }],
    ['a label and a date', { label: 'INBOX', after: '2026-10-01' }],
    ['a folder name with a space and no slash', { folder: 'Family photos' }],
    ['a search with a secret word in free text', { query: 'my token budget and secret santa plans' }],
    ['a calendar time zone', { timeZone: 'America/New_York' }],
    ['another calendar time zone', { time_zone: 'Europe/London' }],
  ])('a mail read of %s keeps both offers', async (_, args) => {
    const decision = await classifyTier(
      readAction({ tool_name: 'list-messages', canonical_params: { account: 'work', ...args } }),
      makeCtx({ services: servicesGranting([grantFor('list-messages')]) }),
    );
    expect(decision.tier).toBe(1);
    expect(decision.inspection).toBe(true);
    expect(decision.secret_path_read).not.toBe(true);
  });

  test('a first-party read-only tool with a path argument still runs silently, as before', async () => {
    const decision = await classifyTier(
      {
        ...readAction({
          tool_name: 'list-messages',
          canonical_params: { account: 'work', path: '/home/u/notes/todo.md' },
          mcp_hints: { read_only_hint: true, open_world_hint: false },
        }),
        mcp_first_party: true,
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe(FIRST_PARTY_TOOL_REASON);
  });

  test('a grant on one read does not cover another read, or the same read on another connector', async () => {
    const services = servicesGranting([grantFor('list-messages')]);
    const otherRead = await classifyTier(readAction({ tool_name: 'get-message' }), makeCtx({ services }));
    const otherConnector = await classifyTier(
      readAction({ tool_name: 'list-messages', mcp_server_name: 'work-mail' }),
      makeCtx({ services }),
    );
    expect([otherRead.tier, otherConnector.tier]).toEqual([3, 3]);
  });
});

describe('a silent search row names only what was searched', () => {
  const SESSION_ID = '5f0c9a3e-2b7d-4c1a-9e8f-7a6b5c4d3e2f';
  const MODEL = 'provider-model-x9';
  const PLUMBED_SEARCH: SentinelAction = {
    tool_name: 'web_search',
    canonical_params: { query: 'Lisbon weather today', session_id: SESSION_ID, model: MODEL },
    tool_type: 'mcp',
    mcp_server_name: 'search',
    mcp_search_provider: true,
    mcp_search_tool: true,
    mcp_search_plumbing_fields: ['session_id', 'model'],
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };

  it('keeps the session id and model name out of the reason and the silent query a person reads', async () => {
    const decision = await classifyTier(PLUMBED_SEARCH, makeCtx());
    expect(decision).toMatchObject({ tier: 1, silent_search_query: 'Lisbon weather today' });
    expect(decision.reason_detail).toBe('Searched: Lisbon weather today');
    for (const text of [decision.reason_detail, decision.silent_search_query]) {
      expect(text).not.toContain(SESSION_ID);
      expect(text).not.toContain(MODEL);
    }
  });
});

describe('a held server key is never shown raw on a card', () => {
  // Invented key, shaped so no secret-name rule matches it.
  const KEY = 'sk-live-Qz9xR7mLp2VbT8kHw4YcN1dF0e';
  const keyCtx = (): ClassifyContext => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.outboundSecrets = () => Promise.resolve([KEY]);
    return makeCtx({ services });
  };
  const searchWith = (tool_name: string, params: Record<string, unknown>): SentinelAction => ({
    tool_name,
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'search',
    mcp_search_provider: true,
    mcp_search_tool: true,
    mcp_search_plumbing_fields: ['session_id'],
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  });

  it('holds a search whose plumbing field carries the key, and masks it on the card', async () => {
    const decision = await classifyTier(searchWith('web_search', { query: 'lisbon', session_id: KEY }), keyCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_guard' });
    expect(decision.card?.outbound_text ?? '').not.toContain(KEY);
  });

  it('masks the key on a card whose search would be refused for other reasons', async () => {
    const decision = await classifyTier(searchWith('delete_search', { query: 'lisbon', session_id: KEY }), keyCtx());
    expect(decision.tier).toBe(3);
    expect(JSON.stringify(decision.card)).not.toContain(KEY);
    expect(decision.approval_token_id).not.toBeNull();
  });
});

describe('a search follows the same whole-link rule as a lookup', () => {
  const PAGE = 'https://photos.meadowbrook.net/fox.jpg';

  function ctxWithPage(): ClassifyContext {
    const ctx = makeCtx();
    recordPersonText({ provenance: ctx.web_search.provenance, text: `My fox photo: ${PAGE}` });
    recordUntrustedText({
      provenance: ctx.web_search.provenance,
      text: 'More photos at photos.meadowbrook.net',
      source: 'page',
    });
    return ctx;
  }

  function fetchOf(url: string): SentinelAction {
    return {
      tool_name: 'web_search',
      canonical_params: { query: 'fox photo', urls: [url] },
      tool_type: 'mcp',
      mcp_server_name: 'search',
      mcp_search_provider: true,
      mcp_search_tool: true,
      mcp_search_plumbing_fields: ['session_id'],
      mcp_hints: { read_only_hint: true, open_world_hint: true },
    };
  }

  it('runs silently for the link exactly as the person gave it', async () => {
    const decision = await classifyTier(fetchOf(PAGE), ctxWithPage());
    expect(decision.tier).toBe(1);
  });

  it('asks when the link carries words after it', async () => {
    const decision = await classifyTier(fetchOf(`${PAGE} as shown`), ctxWithPage());
    expect(decision).toMatchObject({ tier: 3, reason: SEARCH_STEERED_REASON });
  });
});
