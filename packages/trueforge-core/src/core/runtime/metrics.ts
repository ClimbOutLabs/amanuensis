import { z } from '@hono/zod-openapi';
import type { ToolResultDisposition } from '../events/schema';
import type { CompletionUsage } from '../llm/LLMTypes';

/** How one tool call ended, as the reply's per-reply counts report it. */
type ToolResultKind = 'ok' | 'refused' | 'unavailable' | 'error';

/** Tool call counts for one reply, one count per result kind. */
export const ReplyResultsByKindSchema = z
  .object({
    ok: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .openapi('ReplyResultsByKind');

/** Billable aggregate — thread/orchestrator totals (`total_*`), plus the per-reply counts behind the turn's row. */
export const AgentThreadMetricsSchema = z
  .object({
    total_input_tokens: z.number().int().nonnegative(),
    total_output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    total_cache_read_tokens: z.number().int().nonnegative().optional(),
    total_cache_write_tokens: z.number().int().nonnegative().optional(),
    total_reasoning_tokens: z.number().int().nonnegative().optional(),
    total_cost_in_usd: z.number().nonnegative().optional(),
    iterations: z.number().int().nonnegative(),
    sub_agent_steps: z.number().int().nonnegative(),
    total_tool_calls: z.number().int().nonnegative(),
    tool_calls_by_tool: z.record(z.string(), z.number().int().nonnegative()),
    results_by_kind: ReplyResultsByKindSchema,
    guard_fired: z.string().nullable(),
    claim_mismatch: z.boolean(),
    last_call_input_tokens: z.number().int().nonnegative().nullable(),
    time_to_first_token_ms: z.number().int().nonnegative().nullable(),
    total_summarizations: z.number().int().nonnegative(),
    total_sub_agents: z.number().int().nonnegative(),
  })
  .openapi('AgentThreadMetrics');

export type AgentThreadMetrics = z.infer<typeof AgentThreadMetricsSchema>;

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

export function createEmptyAgentThreadMetrics(): AgentThreadMetrics {
  return {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    iterations: 0,
    sub_agent_steps: 0,
    total_tool_calls: 0,
    tool_calls_by_tool: {},
    results_by_kind: { ok: 0, refused: 0, unavailable: 0, error: 0 },
    guard_fired: null,
    claim_mismatch: false,
    last_call_input_tokens: null,
    time_to_first_token_ms: null,
    total_summarizations: 0,
    total_sub_agents: 0,
  };
}

/** Fold one per-call completion usage into aggregated thread metrics. */
export function updateMetricsFromUsage(target: AgentThreadMetrics, usage: CompletionUsage): void {
  target.total_input_tokens += usage.input_tokens;
  target.total_output_tokens += usage.output_tokens;
  target.total_tokens += usage.total_tokens;
  target.total_cache_read_tokens = sumOptional(target.total_cache_read_tokens, usage.cache_read_tokens);
  target.total_cache_write_tokens = sumOptional(target.total_cache_write_tokens, usage.cache_write_tokens);
  target.total_reasoning_tokens = sumOptional(target.total_reasoning_tokens, usage.reasoning_tokens);
  target.total_cost_in_usd = sumOptional(target.total_cost_in_usd, usage.cost_in_usd);
  target.last_call_input_tokens = usage.input_tokens;
}

/**
 * Maps a tool result's disposition to the reply's result kind: a person's decline or a policy block
 * is `refused`, a call that never ran is `unavailable`, and a failed or unknown outcome is `error`.
 */
export function toolResultKindFromDisposition(disposition: ToolResultDisposition): ToolResultKind {
  switch (disposition) {
    case 'executed_ok':
      return 'ok';
    case 'denied':
    case 'policy_blocked':
      return 'refused';
    case 'never_ran':
      return 'unavailable';
    case 'executed_nonzero':
    case 'outcome_unknown':
      return 'error';
  }
}

/**
 * Records one finished tool call. `claim_mismatch` tracks the most recent call, so it ends up true
 * when the last call did not succeed.
 */
export function recordToolCallResult(
  target: AgentThreadMetrics,
  {
    toolName,
    disposition,
    reasonCode,
  }: { toolName: string; disposition: ToolResultDisposition; reasonCode: string | null },
): void {
  const kind = toolResultKindFromDisposition(disposition);
  target.total_tool_calls++;
  target.tool_calls_by_tool[toolName] = (target.tool_calls_by_tool[toolName] ?? 0) + 1;
  target.results_by_kind[kind]++;
  if (disposition === 'policy_blocked') {
    target.guard_fired ??= reasonCode ?? 'policy_blocked';
  }
  target.claim_mismatch = kind !== 'ok';
}

/**
 * Adds a thread's metrics into a total. Sub-agent threads pass `isSubAgent` so their steps count
 * toward `sub_agent_steps`. `claim_mismatch`, `last_call_input_tokens` and `time_to_first_token_ms`
 * describe the root thread's reply only, so they are not summed here.
 */
export function addAgentThreadMetrics({
  target,
  source,
  isSubAgent,
}: {
  target: AgentThreadMetrics;
  source: AgentThreadMetrics;
  isSubAgent: boolean;
}): void {
  target.total_input_tokens += source.total_input_tokens;
  target.total_output_tokens += source.total_output_tokens;
  target.total_tokens += source.total_tokens;
  target.total_cache_read_tokens = sumOptional(target.total_cache_read_tokens, source.total_cache_read_tokens);
  target.total_cache_write_tokens = sumOptional(target.total_cache_write_tokens, source.total_cache_write_tokens);
  target.total_reasoning_tokens = sumOptional(target.total_reasoning_tokens, source.total_reasoning_tokens);
  target.total_cost_in_usd = sumOptional(target.total_cost_in_usd, source.total_cost_in_usd);
  target.iterations += source.iterations;
  target.sub_agent_steps += isSubAgent ? source.iterations : source.sub_agent_steps;
  target.total_tool_calls += source.total_tool_calls;
  for (const [toolName, count] of Object.entries(source.tool_calls_by_tool)) {
    target.tool_calls_by_tool[toolName] = (target.tool_calls_by_tool[toolName] ?? 0) + count;
  }
  target.results_by_kind.ok += source.results_by_kind.ok;
  target.results_by_kind.refused += source.results_by_kind.refused;
  target.results_by_kind.unavailable += source.results_by_kind.unavailable;
  target.results_by_kind.error += source.results_by_kind.error;
  target.guard_fired ??= source.guard_fired;
  target.total_summarizations += source.total_summarizations;
  target.total_sub_agents += source.total_sub_agents;
}
