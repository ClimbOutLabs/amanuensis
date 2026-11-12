/**
 * A scheduled run makes and changes spaces without asking, and nobody watches it. Each change it
 * saves leaves one line in the activity log. A chat, where the person sees the change happen, a
 * write that saved nothing, and a write that failed leave none.
 */
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { CallToolResponse, IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { stampSentinelDecision } from '../../../src/core/mcp/ToolSet';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { classifyTier } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { SPACE_SERVER_ID, SPACE_WRITE_NOTHING_SAVED_FIELD } from '../../../src/core/spaces/toolContract';

const IDENTITY = {
  tenant_id: 't1',
  created_by: 'u1',
  conversation_id: 'conv-1',
  repository_id: null,
  workspace_cwd: null,
  agent_intent: null,
};

function servicesWithLog(input: { scheduledRun: boolean; logDown?: boolean | undefined }): {
  services: SentinelServices;
  records: AuditRecordInput[];
} {
  const records: AuditRecordInput[] = [];
  const base = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  base.audit = {
    record: record => {
      if (input.logDown === true) {
        return Promise.reject(new Error('activity log is down'));
      }
      records.push(record);
      return Promise.resolve();
    },
  };
  return { services: input.scheduledRun ? forUnattendedRun(base) : base, records };
}

/** The call as the host stamps it: classified by the real rules, then run. */
async function runSpaceCall(input: {
  services: SentinelServices;
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResponse;
}): Promise<{ disposition: string | undefined; executed: boolean }> {
  const decision = await classifyTier(
    {
      tool_name: input.toolName,
      canonical_params: input.args,
      tool_type: 'truefoundry-system',
      mcp_server_name: SPACE_SERVER_ID,
      mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
    },
    { ...IDENTITY, services: input.services, web_search: createWebSearchTurnState() },
  );
  const tool_info: InternalToolCallInfo = {
    type: 'truefoundry-system',
    mcp_server_id: SPACE_SERVER_ID,
    mcp_server_name: SPACE_SERVER_ID,
    original_tool_name: input.toolName,
    ...stampSentinelDecision({ decision }),
  };
  const callTool = jest.fn(() => Promise.resolve(input.result));
  const toolSet: IToolSet = {
    name: SPACE_SERVER_ID,
    id: SPACE_SERVER_ID,
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool,
  };
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: input.toolName, arguments: JSON.stringify(input.args) },
        tool_info,
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([[input.toolName, { toolSet, originalToolName: input.toolName }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
    sentinel: { services: input.services, web_search: createWebSearchTurnState(), identity: IDENTITY },
  });
  const outcome = result.toolCallResults[0];
  if (outcome === undefined) {
    throw new Error('expected one tool call result');
  }
  return { disposition: outcome.disposition, executed: callTool.mock.calls.length === 1 };
}

const SAVED = toolResultResponse({ text: JSON.stringify({ summary: 'Created space "Apartment listings" (revision 1).' }) });

describe('a space change a scheduled run saved', () => {
  it('leaves one line for a new space, naming it', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true });
    const outcome = await runSpaceCall({
      services,
      toolName: 'create_space',
      args: { name: 'Apartment listings', body: '# Listings' },
      result: SAVED,
    });

    expect(outcome).toEqual({ disposition: 'executed_ok', executed: true });
    expect(records).toEqual([
      {
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        tier: 1,
        tool_name: 'create_space',
        description: 'Created the space Apartment listings.',
        outcome: 'logged',
        auto_deny_reason: null,
      },
    ]);
  });

  it('leaves one line for a change to a space, naming it', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true });
    await runSpaceCall({
      services,
      toolName: 'edit_space',
      args: { space_name: 'Apartment listings', edits: [{ type: 'append', content: '- 12 Elm Street' }] },
      result: toolResultResponse({ text: JSON.stringify({ summary: 'Updated space "Apartment listings" (revision 2).' }) }),
    });

    expect(records.map(record => record.description)).toEqual(['Updated the space Apartment listings.']);
  });

  it('leaves no line when the write saved nothing new', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true });
    const outcome = await runSpaceCall({
      services,
      toolName: 'edit_space',
      args: { space_name: 'Apartment listings', edits: [{ type: 'append', content: '- 12 Elm Street' }] },
      result: toolResultResponse({
        text: JSON.stringify({ summary: 'Nothing was added.', [SPACE_WRITE_NOTHING_SAVED_FIELD]: true }),
      }),
    });

    expect(outcome.executed).toBe(true);
    expect(records).toEqual([]);
  });

  it('leaves no line when the write failed', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true });
    await runSpaceCall({
      services,
      toolName: 'create_space',
      args: { name: 'Apartment listings', body: '# Listings' },
      result: toolResultResponse({ text: JSON.stringify({ error: 'That name is taken.' }), isError: true }),
    });

    expect(records).toEqual([]);
  });

  it('leaves no line for reading a space', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true });
    await runSpaceCall({
      services,
      toolName: 'get_space',
      args: { space_name: 'Apartment listings' },
      result: toolResultResponse({ text: JSON.stringify({ space: { name: 'Apartment listings' } }) }),
    });

    expect(records).toEqual([]);
  });

  it('finishes the call the same way when the activity log is down', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: true, logDown: true });
    const outcome = await runSpaceCall({
      services,
      toolName: 'create_space',
      args: { name: 'Apartment listings', body: '# Listings' },
      result: SAVED,
    });

    expect(outcome).toEqual({ disposition: 'executed_ok', executed: true });
    expect(records).toEqual([]);
  });
});

describe('a space change made in a chat', () => {
  it('runs without asking and adds no line, as before', async () => {
    const { services, records } = servicesWithLog({ scheduledRun: false });
    const outcome = await runSpaceCall({
      services,
      toolName: 'create_space',
      args: { name: 'Apartment listings', body: '# Listings' },
      result: SAVED,
    });

    expect(outcome).toEqual({ disposition: 'executed_ok', executed: true });
    expect(records).toEqual([]);
  });
});
