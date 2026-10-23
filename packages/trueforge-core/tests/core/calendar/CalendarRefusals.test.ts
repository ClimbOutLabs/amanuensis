import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { build } from './harness';

const WRITE = ['gmail_read', 'calendar_read', 'calendar_write'] as const;

const NO_START = { title: 'Dentist', end: '2026-10-19T10:00', location: '12 Main St' };

function auditingServices(rows: AuditRecordInput[]): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: async row => {
        rows.push(row);
      },
    },
  };
}

/** Runs refused calls through the real dispatch path, with no approval, the way the model's calls reach it. */
async function runCalls(input: {
  built: Awaited<ReturnType<typeof build>>;
  calls: { id: string; name: 'create_event'; arguments: Record<string, unknown> }[];
  /** A refusal the reply guard made before dispatch, set on every call instead of the calendar's own check. */
  preDispatchFailure?: NonNullable<InternalToolCallInfo['pre_dispatch_failure']>;
}) {
  const { tools, sentinel } = input.built;
  const tool_calls = await Promise.all(
    input.calls.map(async call => {
      const info = await tools.toolCallInfo({ name: call.name, arguments: call.arguments });
      return {
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        tool_info:
          input.preDispatchFailure === undefined ? info : { ...info, pre_dispatch_failure: input.preDispatchFailure },
      };
    }),
  );
  const message: InternalEnrichedAssistantMessage = { role: 'assistant', content: null, tool_calls };
  return await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([['create_event', { toolSet: tools, originalToolName: 'create_event' }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: sentinel.services,
      web_search: createWebSearchTurnState(),
      identity: {
        tenant_id: sentinel.tenant_id,
        created_by: sentinel.created_by,
        conversation_id: sentinel.conversation_id,
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
}

describe('a create the host refuses before it is shown', () => {
  it('names the missing field to the model and gives the person one plain line with the next step', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await built.tools.toolCallInfo({ name: 'create_event', arguments: NO_START });

    expect(info.pre_dispatch_failure?.message).toContain('the start time was missing');
    expect(info.pre_dispatch_failure?.owner_message).toBe(
      'Aman could not add the event. The event details were not valid: the start time was missing. Ask again with the details corrected.',
    );
  });

  it('names a field that is present but in the wrong form, in plain words', async () => {
    const built = await build({ routes: [], features: [...WRITE], timeZone: 'America/New_York' });
    const info = await built.tools.toolCallInfo({
      name: 'create_event',
      arguments: { ...NO_START, start: 'soon-ish' },
    });

    expect(info.pre_dispatch_failure?.message).toContain('the start time was not in the right form');
  });

  it('writes one audit row, marked not done, for one refused create', async () => {
    const rows: AuditRecordInput[] = [];
    const built = await build({
      routes: [],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services: auditingServices(rows),
    });

    const result = await runCalls({ built, calls: [{ id: 'c1', name: 'create_event', arguments: NO_START }] });

    expect(result.toolCallResults[0]?.disposition).toBe('policy_blocked');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_name: 'create_event',
      outcome: 'auto_denied',
      auto_deny_reason: 'tool_not_prepared',
    });
    expect(rows[0]?.description).toContain('not done');
    expect(rows[0]?.description).toContain('the start time was missing');
  });

  it('shows one line for 34 identical refusals, and still writes a row for each', async () => {
    const rows: AuditRecordInput[] = [];
    const built = await build({
      routes: [],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services: auditingServices(rows),
    });
    const calls = Array.from({ length: 34 }, (_, index) => ({
      id: `c${String(index)}`,
      name: 'create_event' as const,
      arguments: NO_START,
    }));

    const result = await runCalls({ built, calls });

    const lines = new Set(result.toolCallResults.map(outcome => outcome.remediation?.message));
    expect(lines.size).toBe(1);
    expect(rows).toHaveLength(34);
    expect(built.google.urls.filter(entry => entry.startsWith('POST '))).toHaveLength(0);
  });
});

describe('a refusal the reply guard makes before dispatch', () => {
  it('gives the person one plain line, says why, and writes one audit row for it', async () => {
    const rows: AuditRecordInput[] = [];
    const built = await build({
      routes: [],
      features: [...WRITE],
      timeZone: 'America/New_York',
      services: auditingServices(rows),
    });
    const owner =
      'One of the actions in this reply could not run: the title was missing. Ask again to try it once more.';
    const result = await runCalls({
      built,
      calls: [{ id: 'c1', name: 'create_event', arguments: NO_START }],
      preDispatchFailure: { kind: 'pre_dispatch_failed', message: 'the title was missing', owner_message: owner },
    });

    expect(result.toolCallResults[0]?.disposition).toBe('never_ran');
    expect(result.toolCallResults[0]?.remediation).toEqual({
      reason_code: 'tool_pre_dispatch_failed',
      message: owner,
      suggested_action: 'contact_user',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'auto_denied', auto_deny_reason: 'tool_not_prepared' });
    expect(rows[0]?.description).toContain('the title was missing');
  });
});
