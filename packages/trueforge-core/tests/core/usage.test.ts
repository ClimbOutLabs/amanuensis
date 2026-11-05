import { CompletionUsageSchema, getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { CHARS_PER_TOKEN, describeContentSize, estimateTokensForString, mergeUsage } from '../../src/core/llm/usage';
import {
  addAgentThreadMetrics,
  createEmptyAgentThreadMetrics,
  recordToolCallResult,
  toolResultKindFromDisposition,
  updateMetricsFromUsage,
} from '../../src/core/runtime/metrics';

describe('CompletionUsage', () => {
  it('accepts the canonical harness usage shape', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 3,
      cost_in_usd: 0.12,
    };
    expect(CompletionUsageSchema.parse(usage)).toEqual(usage);
  });

  it('requires input, output, and total token counts', () => {
    expect(CompletionUsageSchema.safeParse({}).success).toBe(false);
  });

  it('uses zero for required token counts in empty usage', () => {
    expect(getEmptyUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});

describe('CHARS_PER_TOKEN', () => {
  it('is the shared characters-per-token figure behind the token estimate', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokensForString('x'.repeat(8))).toBe(2);
    expect(estimateTokensForString('x'.repeat(CHARS_PER_TOKEN))).toBe(1);
  });
});

describe('describeContentSize', () => {
  it('formats characters with thousands separators', () => {
    expect(describeContentSize('x'.repeat(50_000))).toBe('50,000 characters');
    expect(describeContentSize('')).toBe('0 characters');
  });
});

describe('mergeUsage', () => {
  it('sums cost across model calls', () => {
    const merged = mergeUsage(
      {
        ...getEmptyUsage(),
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_in_usd: 0.12,
      },
      {
        ...getEmptyUsage(),
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        cost_in_usd: 0.23,
      },
    );

    expect(merged).toMatchObject({
      input_tokens: 30,
      output_tokens: 13,
      total_tokens: 43,
    });
    expect(merged.cost_in_usd).toBe(0.12 + 0.23);
  });

  it('retains full precision and never rounds cost to cents', () => {
    // Sub-cent inputs must survive verbatim; any rounding to 2 dp would collapse these to 0.
    const merged = mergeUsage({ ...getEmptyUsage(), cost_in_usd: 0.0001 }, { ...getEmptyUsage(), cost_in_usd: 0.0002 });

    expect(merged.cost_in_usd).toBe(0.0001 + 0.0002);
    expect(merged.cost_in_usd).toBeGreaterThan(0);
  });

  it('preserves a missing cost as absent until a call reports one', () => {
    const merged = mergeUsage(getEmptyUsage(), { ...getEmptyUsage(), cost_in_usd: 0.5 });

    expect(merged.cost_in_usd).toBe(0.5);
  });

  it('keeps optional fields undefined when neither side reports them', () => {
    const merged = mergeUsage(getEmptyUsage(), getEmptyUsage());

    expect(merged.cache_read_tokens).toBeUndefined();
    expect(merged.cache_write_tokens).toBeUndefined();
    expect(merged.reasoning_tokens).toBeUndefined();
    expect(merged.cost_in_usd).toBeUndefined();
  });

  it('sums flat cache, reasoning, and cost fields', () => {
    const merged = mergeUsage(
      { ...getEmptyUsage(), cache_read_tokens: 9, cache_write_tokens: 2, reasoning_tokens: 3, cost_in_usd: 0.1 },
      { ...getEmptyUsage(), cache_read_tokens: 4, cache_write_tokens: 3, reasoning_tokens: 5, cost_in_usd: 0.2 },
    );
    expect(merged.cache_read_tokens).toBe(13);
    expect(merged.cache_write_tokens).toBe(5);
    expect(merged.reasoning_tokens).toBe(8);
    expect(merged.cost_in_usd).toBe(0.1 + 0.2);
  });
});

describe('AgentThreadMetrics', () => {
  it('initializes required token totals to zero and leaves optional totals undefined', () => {
    const target = createEmptyAgentThreadMetrics();
    addAgentThreadMetrics({ target, source: createEmptyAgentThreadMetrics(), isSubAgent: false });

    expect(target.total_input_tokens).toBe(0);
    expect(target.total_output_tokens).toBe(0);
    expect(target.total_tokens).toBe(0);
    expect(target.total_cache_read_tokens).toBeUndefined();
    expect(target.total_cost_in_usd).toBeUndefined();
  });

  it('materializes required token aggregates after folding usage', () => {
    const target = createEmptyAgentThreadMetrics();

    updateMetricsFromUsage(target, getEmptyUsage());

    expect(target.total_input_tokens).toBe(0);
    expect(target.total_output_tokens).toBe(0);
    expect(target.total_tokens).toBe(0);
    expect(target.total_cache_read_tokens).toBeUndefined();
    expect(target.total_cache_write_tokens).toBeUndefined();
    expect(target.total_reasoning_tokens).toBeUndefined();
    expect(target.total_cost_in_usd).toBeUndefined();
  });
});

describe('per-reply metrics', () => {
  it('maps each disposition to one result kind', () => {
    expect(toolResultKindFromDisposition('executed_ok')).toBe('ok');
    expect(toolResultKindFromDisposition('denied')).toBe('refused');
    expect(toolResultKindFromDisposition('policy_blocked')).toBe('refused');
    expect(toolResultKindFromDisposition('never_ran')).toBe('unavailable');
    expect(toolResultKindFromDisposition('executed_nonzero')).toBe('error');
    expect(toolResultKindFromDisposition('outcome_unknown')).toBe('error');
  });

  it('records the guard that blocked a call and whether the last call failed', () => {
    const target = createEmptyAgentThreadMetrics();

    recordToolCallResult(target, {
      toolName: 'send_email',
      disposition: 'policy_blocked',
      reasonCode: 'tool_policy_blocked',
    });
    expect(target.guard_fired).toBe('tool_policy_blocked');
    expect(target.claim_mismatch).toBe(true);

    recordToolCallResult(target, { toolName: 'search', disposition: 'executed_ok', reasonCode: null });
    expect(target.guard_fired).toBe('tool_policy_blocked');
    expect(target.claim_mismatch).toBe(false);
    expect(target.tool_calls_by_tool).toEqual({ send_email: 1, search: 1 });
    expect(target.results_by_kind).toEqual({ ok: 1, refused: 1, unavailable: 0, error: 0 });
  });

  it('rolls sub-agent steps and tool counts into the total without copying the root signals', () => {
    const root = createEmptyAgentThreadMetrics();
    root.iterations = 2;
    root.claim_mismatch = true;
    recordToolCallResult(root, { toolName: 'search', disposition: 'executed_ok', reasonCode: null });

    const child = createEmptyAgentThreadMetrics();
    child.iterations = 1;
    recordToolCallResult(child, { toolName: 'search', disposition: 'executed_nonzero', reasonCode: null });

    const total = createEmptyAgentThreadMetrics();
    addAgentThreadMetrics({ target: total, source: root, isSubAgent: false });
    addAgentThreadMetrics({ target: total, source: child, isSubAgent: true });

    expect(total.iterations).toBe(3);
    expect(total.sub_agent_steps).toBe(1);
    expect(total.tool_calls_by_tool).toEqual({ search: 2 });
    expect(total.results_by_kind).toEqual({ ok: 1, refused: 0, unavailable: 0, error: 1 });
    expect(total.claim_mismatch).toBe(false);
  });
});
