import { ToolResponseEventV2Schema } from '../../../src/core/events/schema';
import { buildSubAgentParentToolResponse } from '../../../src/core/runtime/AgentThreadOrchestrator';

describe('sub-agent parent tool response boundary', () => {
  it('emits a canonical successful v2 result', () => {
    const result = buildSubAgentParentToolResponse({
      threadId: 'parent',
      toolCallId: 'subagent-call',
      content: 'Completed the delegated task.',
      failureMessage: undefined,
    });

    expect(ToolResponseEventV2Schema.parse(result.event)).toMatchObject({
      type: 'tool.response.v2',
      thread_id: 'parent',
      tool_call_id: 'subagent-call',
      disposition: 'executed_ok',
      admission_provenance: { source: 'internal' },
    });
  });

  it('emits a canonical failed v2 result with remediation', () => {
    const result = buildSubAgentParentToolResponse({
      threadId: 'parent',
      toolCallId: 'subagent-call',
      content: 'The delegated task failed.',
      failureMessage: 'The delegated task failed.',
    });

    expect(ToolResponseEventV2Schema.parse(result.event)).toMatchObject({
      type: 'tool.response.v2',
      disposition: 'executed_nonzero',
      remediation: { reason_code: 'subagent_failed', suggested_action: 'change_strategy' },
      admission_provenance: { source: 'internal' },
    });
  });
});
