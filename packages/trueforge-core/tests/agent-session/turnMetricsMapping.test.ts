import { turnMetricsFromAgentThreadMetrics } from '../../src/agent-session/TurnHandle';
import { createEmptyAgentThreadMetrics } from '../../src/core/runtime/metrics';

describe('turnMetricsFromAgentThreadMetrics', () => {
  it('leaves the last call size and first token time absent when the reply had no model call', () => {
    const turnMetrics = turnMetricsFromAgentThreadMetrics(createEmptyAgentThreadMetrics(), null, 42);

    expect(turnMetrics.last_call_input_tokens).toBeUndefined();
    expect(turnMetrics.time_to_first_token_ms).toBeNull();
    expect(turnMetrics.guard_fired).toBeNull();
    expect(turnMetrics.wall_time_ms).toBe(42);
  });

  it('maps the per-reply counts and the last call size', () => {
    const metrics = {
      ...createEmptyAgentThreadMetrics(),
      total_input_tokens: 120,
      total_output_tokens: 30,
      total_tokens: 150,
      total_cache_read_tokens: 80,
      total_reasoning_tokens: 12,
      iterations: 3,
      sub_agent_steps: 1,
      tool_calls_by_tool: { read_file: 2 },
      results_by_kind: { ok: 1, refused: 1, unavailable: 0, error: 0 },
      guard_fired: 'repeated_denied_action',
      claim_mismatch: true,
      time_to_first_token_ms: 900,
    };

    const turnMetrics = turnMetricsFromAgentThreadMetrics(metrics, 70, 5000);

    expect(turnMetrics).toMatchObject({
      steps: 3,
      sub_agent_steps: 1,
      total_input_tokens: 120,
      total_cache_read_tokens: 80,
      total_output_tokens: 30,
      total_reasoning_tokens: 12,
      last_call_input_tokens: 70,
      tool_calls_by_tool: { read_file: 2 },
      results_by_kind: { ok: 1, refused: 1, unavailable: 0, error: 0 },
      guard_fired: 'repeated_denied_action',
      claim_mismatch: true,
      wall_time_ms: 5000,
      time_to_first_token_ms: 900,
    });
  });
});
