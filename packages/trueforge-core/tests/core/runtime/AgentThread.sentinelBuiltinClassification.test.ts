/**
 * Sentinel builtin classification regression tests.
 *
 * Built-in host tools (LocalToolMCP subclasses assembled from capabilities)
 * are never wrapped in a Sentinel-aware ToolSet, so nothing classifies them
 * at the toolset layer. classifyUnstampedToolCall is the choke point in
 * AgentThread that classifies them with their final arguments before the
 * turn can dispatch. These tests prove an unstamped builtin gets a tier
 * stamp (and a Tier 3 card for writes), while already-stamped calls,
 * client-side tools, thread creation, and failed calls pass through
 * untouched.
 */
import { z } from 'zod';
import { emptyTaskChecklist } from '../../../src/agent-session/schemas/taskChecklist';
import { REPLACE_TASK_CHECKLIST_TOOL_NAME, taskChecklist } from '../../../src/core/capabilities/builtins/TaskChecklist';
import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { createSentinelHostContext, type SentinelHostContext } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { classifyUnstampedToolCall } from '../../../src/core/runtime/AgentThread';
import { TaskStateToolSet } from '../../../src/core/runtime/TaskStateToolSet';
import { TASK_STATE_TOOL_NAME } from '../../../src/core/runtime/taskState';
import type { AgentTracing } from '../../../src/core/tracing/AgentTracing';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

class SyntheticTools extends LocalToolMCP {
  readonly name = 'synthetic';
  readonly displayName = 'Synthetic';

  constructor(options: { tracing: AgentTracing }) {
    super(options);
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'synthetic_write',
      description: 'Synthetic write op with no effect hints.',
      schema: z.object({}).strict(),
      handler: () => Promise.resolve(toolResultResponse({ text: '{}' })),
    }),
    defineTool({
      name: 'synthetic_read',
      description: 'Synthetic read op declaring itself read-only.',
      schema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
      handler: () => Promise.resolve(toolResultResponse({ text: '{}' })),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

function makeSentinel(): SentinelHostContext {
  return createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    workspace_cwd: null,
  });
}

async function infoFor(toolName: string): Promise<InternalToolCallInfo> {
  const toolset = new SyntheticTools({ tracing: NOOP_AGENT_TRACING });
  return toolset.toolCallInfo({ name: toolName, arguments: {} });
}

test('unstamped builtin write op is classified Tier 3 with a card', async () => {
  const info = await infoFor('synthetic_write');
  expect(info.tier).toBeUndefined();
  const stamped = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info,
  });
  expect(stamped.tier).toBe(3);
  expect(stamped.is_approval_required).toBe(true);
  expect(stamped.tier3_card).not.toBeNull();
  expect(stamped.approval_token_id).not.toBeNull();
});

test('builtin read op declaring readOnlyHint stays Tier 1', async () => {
  const info = await infoFor('synthetic_read');
  const stamped = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info,
  });
  expect(stamped.tier).toBe(1);
  expect(stamped.is_approval_required).toBe(false);
});

test('already-stamped calls are never re-classified', async () => {
  const info = await infoFor('synthetic_write');
  const stampedOnce: InternalToolCallInfo = { ...info, tier: 1 };
  const result = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info: stampedOnce,
  });
  expect(result).toBe(stampedOnce);
});

test('client-side tools keep the toolset stamping', async () => {
  const info = await infoFor('synthetic_write');
  const clientSide: InternalToolCallInfo = { ...info, is_client_side: true };
  const result = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info: clientSide,
  });
  expect(result).toBe(clientSide);
});

test('thread-creation calls keep the toolset stamping', async () => {
  const info = await infoFor('synthetic_write');
  const threadCreation: InternalToolCallInfo = { ...info, is_thread_creation: true };
  const result = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info: threadCreation,
  });
  expect(result).toBe(threadCreation);
});

test('calls that failed toolCallInfo are not classified', async () => {
  const info = await infoFor('synthetic_write');
  const failed: InternalToolCallInfo = {
    ...info,
    pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: 'boom' },
  };
  const result = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info: failed,
  });
  expect(result).toBe(failed);
});

test('no sentinel context leaves the call unstamped', async () => {
  const info = await infoFor('synthetic_write');
  const result = await classifyUnstampedToolCall({
    sentinel: undefined,
    canonical_params: {},
    info,
  });
  expect(result).toBe(info);
});

test('replace_task_checklist (agent scratchpad) classifies Tier 1 silent', async () => {
  const capability = taskChecklist({
    access: {
      getTaskChecklist: () => Promise.resolve(emptyTaskChecklist()),
      replaceTaskChecklist: () => Promise.resolve(emptyTaskChecklist()),
    },
    tracing: NOOP_AGENT_TRACING,
  });
  const toolset = capability.systemToolSets?.[0];
  if (!toolset) {
    throw new Error('Expected taskChecklist to provide a system tool set');
  }
  const info = await toolset.toolCallInfo({ name: REPLACE_TASK_CHECKLIST_TOOL_NAME, arguments: {} });
  expect(info.tier).toBeUndefined();
  const stamped = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info,
  });
  expect(stamped.tier).toBe(1);
  expect(stamped.is_approval_required).toBe(false);
  expect(stamped.tier3_card).toBeNull();
});

test('record_finding (agent scratchpad) classifies Tier 1 silent', async () => {
  const toolset = new TaskStateToolSet({ tracing: NOOP_AGENT_TRACING, bankedCount: () => 0 });
  const info = await toolset.toolCallInfo({ name: TASK_STATE_TOOL_NAME, arguments: {} });
  expect(info.tier).toBeUndefined();
  const stamped = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: {},
    info,
  });
  expect(stamped.tier).toBe(1);
  expect(stamped.is_approval_required).toBe(false);
  expect(stamped.tier3_card).toBeNull();
});

test('maps calls keep the host-stamped hosts on the card instead of the unnamed fallback', async () => {
  const base = await infoFor('synthetic_write');
  const info: InternalToolCallInfo = {
    ...base,
    original_tool_name: 'render_map',
    maps_hosts: {
      geocoder: 'https://geocode.example.internal',
      router: 'https://routes.example.internal',
      tile: 'https://tiles.example.internal/{z}/{x}/{y}.png',
    },
  };
  const stamped = await classifyUnstampedToolCall({
    sentinel: makeSentinel(),
    canonical_params: { place_name: 'Paris' },
    info,
  });
  expect(stamped.tier).toBe(3);
  expect(stamped.tier3_card?.plain_what).toContain('geocode.example.internal');
  expect(stamped.tier3_card?.destination_host).toContain('tiles.example.internal');
});

describe('classifyUnstampedToolCall on a connector call', () => {
  const info: InternalToolCallInfo = {
    type: 'mcp',
    original_tool_name: 'frobnicate',
    mcp_server_id: 'misc',
    mcp_server_name: 'misc',
    is_approval_required: true,
  };
  const connector = { server_id: 'misc', destination_host: 'misc.example.com' };

  async function dispatchAgainst(moved: boolean): Promise<string | undefined> {
    const sentinel = makeSentinel();
    const stamped = await classifyUnstampedToolCall({
      sentinel,
      canonical_params: { id: '1' },
      info,
      connector,
    });
    expect(stamped.tier3_card?.destination_host).toBe('misc.example.com');
    return await verifyPreDispatch({
      call: {
        tool_name: 'frobnicate',
        tool_type: 'mcp',
        canonical_params: { id: '1' },
        tier: 3,
        approval_token_id: stamped.approval_token_id ?? null,
        approval_binding: null,
        shell_binding: null,
        connector: moved ? { ...connector, destination_host: 'evil.example' } : connector,
      },
      ctx: {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
        services: sentinel.services,
        offline: false,
      },
    });
  }

  test('the approval verifies against the same connector', async () => {
    expect(await dispatchAgainst(false)).toBeUndefined();
  });

  test('the approval is denied once the connector host differs', async () => {
    expect(await dispatchAgainst(true)).toContain('Approval invalid');
  });
});
