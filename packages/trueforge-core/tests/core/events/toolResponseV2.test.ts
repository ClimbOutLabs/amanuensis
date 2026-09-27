import {
  EventType,
  ToolResponseEventSchema,
  ToolResponseEventV2Schema,
  createToolResponseV2,
} from '../../../src/core/events/schema';

const BASE = {
  id: '01k00000000000000000000000',
  thread_id: 'main',
  tool_call_id: 'call-1',
  created_at: '2026-08-30T00:00:00.000Z',
};

const REQUIRED_REMEDIATION_DISPOSITIONS: ('policy_blocked' | 'never_ran' | 'outcome_unknown')[] = [
  'policy_blocked',
  'never_ran',
  'outcome_unknown',
];

describe('tool.response.v2 contract', () => {
  it('continues to decode a historical tool.response without inventing a disposition', () => {
    const legacy = ToolResponseEventSchema.parse({
      ...BASE,
      type: EventType.TOOL_RESPONSE,
      content: 'historical result',
    });

    expect(legacy.type).toBe('tool.response');
    expect('disposition' in legacy).toBe(false);
  });

  it('rejects a v2 terminal result that omits disposition', () => {
    expect(
      ToolResponseEventV2Schema.safeParse({
        ...BASE,
        type: 'tool.response.v2',
        content: 'result',
      }).success,
    ).toBe(false);
  });

  it('rejects a v2 terminal result without admission provenance', () => {
    expect(
      ToolResponseEventV2Schema.safeParse({
        ...BASE,
        type: 'tool.response.v2',
        content: 'result',
        disposition: 'executed_ok',
      }).success,
    ).toBe(false);
  });

  it.each(REQUIRED_REMEDIATION_DISPOSITIONS)('requires structured remediation for a %s result', disposition => {
    expect(
      ToolResponseEventV2Schema.safeParse({
        ...BASE,
        type: 'tool.response.v2',
        content: 'blocked',
        disposition,
      }).success,
    ).toBe(false);
  });

  it('constructs a policy-blocked event with model-visible disposition and remediation', () => {
    const result = createToolResponseV2({
      ...BASE,
      raw_content: JSON.stringify({ error: 'Private repository fallback blocked' }),
      model_content: null,
      screen: null,
      disposition: 'policy_blocked',
      remediation: {
        reason_code: 'private_repository_fallback',
        message: 'Use the authenticated local checkout instead.',
        suggested_action: 'change_strategy',
      },
      admission_provenance: { source: 'automatic' },
      memoized: false,
      repeat_count: 1,
    });

    expect(result.event).toMatchObject({
      type: 'tool.response.v2',
      disposition: 'policy_blocked',
      remediation: { reason_code: 'private_repository_fallback' },
      admission_provenance: { source: 'automatic' },
    });
    expect(result.model_message.content).toContain('"schema_version":"tool.response.v2"');
    expect(result.model_message.content).toContain('"disposition":"policy_blocked"');
    expect(result.model_message.content).toContain('"suggested_action":"change_strategy"');
    expect(result.model_message.content).toContain('Private repository fallback blocked');
  });

  it('keeps screened display content separate from the model-facing result', () => {
    const raw = '<div>RED-TEAM-CANARY-7Q2X9</div>';
    const result = createToolResponseV2({
      ...BASE,
      raw_content: raw,
      model_content: JSON.stringify({ content_withheld: true, reason_code: 'classifier_malicious' }),
      screen: {
        status: 'flagged',
        action: 'withheld',
        reason_code: 'classifier_malicious',
        score: 0.98,
      },
      disposition: 'executed_ok',
      remediation: undefined,
      admission_provenance: { source: 'automatic' },
      memoized: false,
      repeat_count: 1,
    });

    expect(result.event.screen?.action).toBe('withheld');
    expect(JSON.parse(result.event.content)).toMatchObject({ result: raw });
    expect(result.model_message.content).not.toContain('RED-TEAM-CANARY-7Q2X9');
    expect(result.model_message.content).toContain('content_withheld');
  });
});
