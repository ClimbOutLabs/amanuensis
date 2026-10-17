import type { Logger } from 'winston';
import { RemoteMCP, ToolSet } from '../../../src/core';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import {
  allowsChatApproval,
  allowsToolGrant,
  approvalGrantKey,
  effectiveApprovalDecisions,
  effectiveToolAdmissions,
} from '../../../src/core/mcp/approvalGrant';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import {
  mintImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../../src/core/mcp/implementationPlanGrant';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { ToolSelectorConfig } from '../../../src/core/mcp/ToolSelectorPolicy';
import { sandboxCommandApprovalIdentity } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

// RemoteMCP connects itself via connectRemoteMcp; mock it so a real ToolSet can be exercised
// (to produce genuinely-computed tool_info, not a hand-synthesized one) without real networking.
jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actualUnknown: unknown = jest.requireActual('../../../src/core/mcp/remoteMcpClient');
  const actual = actualUnknown as typeof import('../../../src/core/mcp/remoteMcpClient');
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = connectRemoteMcp as jest.MockedFunction<typeof connectRemoteMcp>;
const noopLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

/** Installs a fake connection serving exactly `tools`, and returns a ToolSet backed by it. */
function makeRealToolSet(params: { tools: ToolSchema[]; selectors: ToolSelectorConfig }): ToolSet {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: params.tools }),
      callTool: () => Promise.reject(new Error('not used in this test')),
      close: () => Promise.resolve(),
    }),
  );
  const remote = new RemoteMCP({
    name: 'real-mcp',
    id: 'real-mcp-id',
    url: 'https://mcp.example.com/mcp',
    headers: {},
    logger: noopLogger,
    tracing: NOOP_AGENT_TRACING,
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  return new ToolSet({ source: remote, selectors: params.selectors, preload: false });
}

function toolInfo(serverId: string, name: string): InternalToolCallInfo {
  return {
    type: 'mcp',
    mcp_server_id: serverId,
    mcp_server_name: serverId,
    original_tool_name: name,
    is_approval_required: true,
  };
}

function toolCall(id: string, info: InternalToolCallInfo): InternalEnrichedToolCall {
  return {
    id,
    type: 'function',
    function: { name: info.original_tool_name, arguments: '{}' },
    tool_info: info,
  };
}

describe('chat approval grants', () => {
  it('authorizes only the exact server and tool', () => {
    const granted = { ...toolInfo('github', 'read_issue'), effect: 'inspect' as const };
    const calls = [
      toolCall('same', granted),
      toolCall('other-tool', { ...toolInfo('github', 'read_file'), effect: 'inspect' }),
      toolCall('other-server', { ...toolInfo('gitlab', 'read_issue'), effect: 'inspect' }),
    ];

    const effective = effectiveApprovalDecisions({
      calls,
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(granted)]),
      implementationPlanGrants: new Set(),
    });

    expect(effective.get('same')).toEqual({ status: 'allow', scope: 'chat' });
    expect(effective.has('other-tool')).toBe(false);
    expect(effective.has('other-server')).toBe(false);
  });

  it('preserves an explicit decision over a chat grant', () => {
    const info = { ...toolInfo('github', 'read_issue'), effect: 'inspect' as const };
    const explicit = new Map<string, ApprovalDecision>([['call', { status: 'deny', reason: 'not this one' }]]);

    expect(
      effectiveApprovalDecisions({
        calls: [toolCall('call', info)],
        decisions: explicit,
        chatApprovalGrants: new Set([approvalGrantKey(info)]),
        implementationPlanGrants: new Set(),
      }),
    ).toEqual(explicit);
  });

  it('offers chat scope only to inspect and verify effects', () => {
    expect(allowsChatApproval({ ...toolInfo('github', 'read_issue'), effect: 'inspect' })).toBe(true);
    expect(allowsChatApproval({ ...toolInfo('github', 'create_issue'), effect: 'edit' })).toBe(false);
    expect(allowsChatApproval({ ...toolInfo('sandbox', 'exec:verify:one'), effect: 'verify' })).toBe(true);
    expect(allowsChatApproval({ ...toolInfo('sandbox', 'exec:edit:one'), effect: 'edit' })).toBe(false);
    expect(allowsChatApproval({ ...toolInfo('sandbox', 'exec:execute:one'), effect: 'execute' })).toBe(false);
    expect(allowsChatApproval({ ...toolInfo('sandbox', 'exec:commit:one'), effect: 'commit' })).toBe(false);
    expect(allowsChatApproval({ ...toolInfo('sandbox', 'exec:push:one'), effect: 'push' })).toBe(false);
  });

  it('does not apply a forged chat grant to an ineligible sandbox command', () => {
    const info = { ...toolInfo('sandbox', 'exec:commit:one'), effect: 'commit' as const };
    const effective = effectiveApprovalDecisions({
      calls: [toolCall('call', info)],
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(info)]),
      implementationPlanGrants: new Set(),
    });
    expect(effective.has('call')).toBe(false);
  });

  it("does not let one verify invocation's chat grant admit a different verify invocation", () => {
    const grantedIdentity = sandboxCommandApprovalIdentity({
      purpose: 'verify',
      command: 'npm test',
      cwd: '/repo',
      env: {},
    });
    const otherIdentity = sandboxCommandApprovalIdentity({
      purpose: 'verify',
      command: 'python -c "import os"',
      cwd: '/repo',
      env: {},
    });
    expect(grantedIdentity).not.toBe(otherIdentity);
    const granted = { ...toolInfo('sandbox', grantedIdentity), effect: 'verify' as const };
    const other = { ...toolInfo('sandbox', otherIdentity), effect: 'verify' as const };
    const effective = effectiveApprovalDecisions({
      calls: [toolCall('granted', granted), toolCall('other', other)],
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(granted)]),
      implementationPlanGrants: new Set(),
    });
    expect(effective.get('granted')).toEqual({ status: 'allow', scope: 'chat' });
    expect(effective.has('other')).toBe(false);
  });

  it('end-to-end: auto-approves a real read-only local MCP tool from a matching chat grant', async () => {
    const readTool: ToolSchema = {
      name: 'read_thing',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, openWorldHint: false },
    };
    const toolSet = makeRealToolSet({
      tools: [readTool],
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: ['@all'] },
    });

    // Genuinely computed by ToolSet + ToolSet.ts's isReadOnlyLocalTool, not hand-synthesized.
    const info = await toolSet.toolCallInfo({ name: 'read_thing', arguments: {} });
    expect(info.effect).toBe('inspect');
    expect(info.is_approval_required).toBe(true);

    const call = toolCall('call', info);
    const effective = effectiveApprovalDecisions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(info)]),
      implementationPlanGrants: new Set(),
    });
    expect(effective.get('call')).toEqual({ status: 'allow', scope: 'chat' });
  });

  it('end-to-end: does not auto-approve a real open-world read-only MCP tool, even with a grant present for it', async () => {
    const openWorldReadTool: ToolSchema = {
      name: 'open_world_read_thing',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, openWorldHint: true },
    };
    const toolSet = makeRealToolSet({
      tools: [openWorldReadTool],
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: ['@all'] },
    });

    const info = await toolSet.toolCallInfo({ name: 'open_world_read_thing', arguments: {} });
    expect(info).not.toHaveProperty('effect');
    expect(info.is_approval_required).toBe(true);

    const call = toolCall('call', info);
    // A grant keyed off this same info (as if forged or stale) must not auto-approve, because
    // allowsChatApproval admits only host-classified inspect and verify effects.
    const effective = effectiveApprovalDecisions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(info)]),
      implementationPlanGrants: new Set(),
    });
    expect(effective.has('call')).toBe(false);
  });
});

describe('chat grant key', () => {
  it('differs by destination and recipient so one grant never covers a different target', () => {
    const base = { ...toolInfo('notes', 'lookup_note'), effect: 'inspect' as const };
    const card = ({ destination, recipient }: { destination: string | null; recipient: string | null }) => ({
      plain_what: 'x',
      plain_why: null,
      cannot_be_undone: null,
      why_asked_again: null,
      destination,
      recipient,
      amount: null,
      parsed_command: null,
      outbound_text: null,
      destination_host: null,
      outbound_truncated: false,
    });
    const keyA = approvalGrantKey({ ...base, tier3_card: card({ destination: 'https://a.example', recipient: null }) });
    const keyB = approvalGrantKey({ ...base, tier3_card: card({ destination: 'https://b.example', recipient: null }) });
    const keyC = approvalGrantKey({ ...base, tier3_card: card({ destination: null, recipient: 'a@example.com' }) });
    expect(new Set([keyA, keyB, keyC]).size).toBe(3);
  });

  it('bars durable scope when the card names a recipient or the tier has no reason', () => {
    const info: InternalToolCallInfo = { ...toolInfo('notes', 'invite_user'), effect: 'inspect', tier: 3 };
    expect(allowsChatApproval(info)).toBe(false);
    expect(allowsToolGrant(info)).toBe(false);
    const named = {
      ...info,
      tier_reason: 'unrecognized_tool',
      tier3_card: {
        plain_what: 'x',
        plain_why: null,
        cannot_be_undone: null,
        why_asked_again: null,
        destination: null,
        recipient: 'guest@example.com',
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
    };
    expect(allowsChatApproval(named)).toBe(false);
    expect(allowsToolGrant(named)).toBe(false);
  });

  it('never admits a Tier 3 send-class call from a chat grant, even a forged one', () => {
    const info: InternalToolCallInfo = {
      ...toolInfo('notes', 'send_note'),
      effect: 'inspect',
      tier: 3,
      tier_reason: 'external_service',
    };
    const effective = effectiveApprovalDecisions({
      calls: [toolCall('call', info)],
      decisions: new Map(),
      chatApprovalGrants: new Set([approvalGrantKey(info)]),
      implementationPlanGrants: new Set(),
    });
    expect(effective.has('call')).toBe(false);
  });
});

describe('always-allow grant eligibility', () => {
  it('admits only a connector tool the host classified as inspection', () => {
    expect(allowsToolGrant({ ...toolInfo('notes', 'lookup_note'), effect: 'inspect' })).toBe(true);
    expect(allowsToolGrant(toolInfo('notes', 'lookup_note'))).toBe(false);
    expect(allowsToolGrant({ ...toolInfo('notes', 'lookup_note'), effect: 'edit' })).toBe(false);
    expect(allowsToolGrant({ ...toolInfo('', 'current_datetime'), type: 'truefoundry-system', effect: 'inspect' })).toBe(
      false,
    );
  });

  it('end-to-end: a real read-only MCP tool that omits openWorldHint is not eligible', async () => {
    const toolSet = makeRealToolSet({
      tools: [{ name: 'peek_thing', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: ['@all'] },
    });
    const info = await toolSet.toolCallInfo({ name: 'peek_thing', arguments: {} });
    expect(allowsToolGrant(info)).toBe(false);
    expect(allowsChatApproval(info)).toBe(false);
  });
});

describe('canonical tool admissions', () => {
  const plan = {
    repository_id: 'repository-a',
    repository_revision: 7,
    branch: 'codex/plan-grants',
    head_sha: 'abcdef012345',
    file_globs: ['packages/core/src/**/*.ts'],
    approach: 'Update the scoped implementation.',
    verify_command_ids: ['core-test'],
  };
  const grant = mintImplementationPlanGrant({
    tenant_id: 'tenant-a',
    created_by: 'user-a',
    session_id: 'session-a',
    workspace_cwd: '/repo',
    checkout_id: `sha256:${'1'.repeat(64)}`,
    plan,
  });

  function replaceTextCall(input: { id: string; path: string }): InternalEnrichedToolCall {
    return {
      id: input.id,
      type: 'function',
      function: {
        name: 'replace_text',
        arguments: JSON.stringify({
          intent: 'Update the implementation',
          cwd: '/repo',
          path: input.path,
          old_text: 'before',
          new_text: 'after',
        }),
      },
      tool_info: {
        ...toolInfo('sandbox', 'replace_text:edit'),
        effect: 'edit',
        implementation_plan_scope: { kind: 'paths', paths: [input.path] },
        implementation_plan_binding: {
          repository_id: plan.repository_id,
          repository_revision: plan.repository_revision,
          workspace_cwd: grant.workspace_cwd,
          branch: plan.branch,
          head_sha: plan.head_sha,
          checkout_id: grant.checkout_id,
        },
      },
    };
  }

  it('selects a matching plan grant once and carries its internal provenance', () => {
    const call = replaceTextCall({ id: 'planned', path: 'packages/core/src/runtime.ts' });
    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('never treats a serialized plan as a legacy chat grant', () => {
    const call = replaceTextCall({ id: 'separated-grant-sources', path: 'packages/core/src/runtime.ts' });
    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set([serializeImplementationPlanGrant(grant)]),
      implementationPlanGrants: new Set(),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: undefined,
      admission_provenance: { source: 'automatic' },
    });
  });

  it('admits a remapped sandbox tool from its host identity', () => {
    const call = replaceTextCall({ id: 'remapped', path: 'packages/core/src/runtime.ts' });
    call.function.name = 'sandbox_replace_text_2';

    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('shares the host-derived structured path scope with the reserved write_file identity', () => {
    const call = replaceTextCall({ id: 'future-write-file', path: 'packages/core/src/newFile.ts' });
    call.function.name = 'sandbox_write_file_3';
    call.tool_info.original_tool_name = 'write_file:edit';

    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('selects the current valid grant when an older overlapping grant is also active', () => {
    const staleGrant = mintImplementationPlanGrant({
      tenant_id: grant.tenant_id,
      created_by: grant.created_by,
      session_id: grant.session_id,
      workspace_cwd: grant.workspace_cwd,
      checkout_id: grant.checkout_id,
      plan: { ...plan, branch: 'codex/stale-plan' },
    });
    const call = replaceTextCall({ id: 'overlapping-grants', path: 'packages/core/src/runtime.ts' });

    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([
        serializeImplementationPlanGrant(staleGrant),
        serializeImplementationPlanGrant(grant),
      ]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('does not admit unrelated MCP tools that imitate sandbox plan tool names', () => {
    const calls: InternalEnrichedToolCall[] = [
      {
        id: 'unrelated-patch',
        type: 'function',
        function: {
          name: 'apply_patch',
          arguments: JSON.stringify({
            patch:
              'diff --git a/packages/core/src/runtime.ts b/packages/core/src/runtime.ts\n--- a/packages/core/src/runtime.ts\n+++ b/packages/core/src/runtime.ts\n@@ -1 +1 @@\n-before\n+after\n',
          }),
        },
        tool_info: {
          ...toolInfo('unrelated-mcp', 'apply_patch:edit'),
          effect: 'edit',
          implementation_plan_scope: { kind: 'paths', paths: ['packages/core/src/runtime.ts'] },
        },
      },
      {
        id: 'unrelated-command',
        type: 'function',
        function: {
          name: 'run_registered_command',
          arguments: JSON.stringify({ command_id: 'core-test' }),
        },
        tool_info: {
          ...toolInfo('unrelated-mcp', 'run_registered_command:repository-a:7:core-test'),
          effect: 'verify',
          implementation_plan_scope: { kind: 'command', command_id: 'core-test' },
        },
      },
    ];

    const admissions = effectiveToolAdmissions({
      calls,
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    for (const call of calls) {
      expect(admissions.get(call.id)).toEqual({
        decision: undefined,
        admission_provenance: { source: 'automatic' },
      });
    }
  });

  it('keeps automatic provenance for calls without explicit, plan, or chat grants', () => {
    const call = replaceTextCall({ id: 'unplanned', path: 'packages/frontend/src/App.tsx' });
    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map(),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: undefined,
      admission_provenance: { source: 'automatic' },
    });
  });

  it('lets an explicit one-call decision admit an edit outside the plan', () => {
    const call = replaceTextCall({ id: 'one-call', path: 'packages/frontend/src/App.tsx' });
    const admissions = effectiveToolAdmissions({
      calls: [call],
      decisions: new Map([[call.id, { status: 'allow', scope: 'once' }]]),
      chatApprovalGrants: new Set(),
      implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
    });

    expect(admissions.get(call.id)).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });
  });
});
