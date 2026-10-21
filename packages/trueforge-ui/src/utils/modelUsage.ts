import { sumKnownCostUsd } from '@truefoundry/trueforge-core/core/util/usageCost';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** One `aman.model.usage` event: the calls one role made on one model during a turn. */
export type ModelUsageEvent = TrueForgeApi.ModelUsagePersistedEvent;

/** One role's calls on one model, summed over a turn. */
export type ModelUsageRow = {
  role: ModelUsageEvent['role'];
  roleLabel: string;
  displayName: string;
  providerLabel: string;
  calls: number;
  reportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when the provider reported no usage, or the model has no known price. */
  costUsd: number | null;
};

/** What a turn spent, from the usage its provider reported. */
export type ModelUsageSummary = {
  /** The model that answered: the chat role's busiest model, else the busiest of any role. */
  answer: Pick<ModelUsageRow, 'displayName' | 'providerLabel'>;
  inputTokens: number;
  outputTokens: number;
  /** Null when any reported call has no known price, so a partial sum is never shown as the total. */
  costUsd: number | null;
  /** Calls whose usage the provider did not report. */
  unreportedCalls: number;
  /** True when no call at all reported usage. */
  noneReported: boolean;
  /** The answer's rows first, then every other role and model. */
  rows: ModelUsageRow[];
  /** Calls other than the answer's own chat role. */
  helperCalls: number;
  /** Models the helper calls ran on, in order of first use. */
  helperModelNames: string[];
};

const ROLE_LABELS: Record<ModelUsageEvent['role'], string> = {
  chat: 'Answer',
  delegation: 'Sub-agent',
  compaction: 'Compaction',
  summarization: 'Memory summary',
  profile_learning: 'Profile learning',
  relevance_judge: 'Library check',
};

const PROVIDER_LABELS: Record<string, string> = {
  tokenfactory: 'Token Factory',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'google-gemini': 'Google Gemini',
  fireworks: 'Fireworks',
  zai: 'Z.ai',
  moonshot: 'Moonshot',
  alibaba: 'Alibaba',
  together: 'Together',
  truefoundry: 'TrueFoundry',
  custom: 'Custom provider',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const tokenFormat = new Intl.NumberFormat('en-US');

export function formatTokens(tokens: number): string {
  return tokenFormat.format(tokens);
}

/** Four decimals under a dollar, since a single answer costs fractions of a cent. */
export function formatCostUsd(cost: number): string {
  if (cost > 0 && cost < 0.00005) return '<$0.0001';
  return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
}

/** Costs come from a price table, not the provider's invoice, so every place that shows one says so. */
export const LIST_PRICE_HINT = 'Estimated from per-million-token list prices, not your bill.';

/** "$0.0011 at list price". */
export function describeListPriceCost(cost: number): string {
  return `${formatCostUsd(cost)} at list price`;
}

function toRows(events: readonly ModelUsageEvent[]): ModelUsageRow[] {
  const rows = new Map<string, ModelUsageRow & { costParts: (number | null)[] }>();
  for (const event of events) {
    const key = [event.role, event.provider, event.modelName, event.modelId].join('\u0000');
    const row = rows.get(key) ?? {
      role: event.role,
      roleLabel: ROLE_LABELS[event.role],
      displayName: event.displayName,
      providerLabel: providerLabel(event.provider),
      calls: 0,
      reportedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costParts: [],
    };
    row.calls += event.calls;
    row.reportedCalls += event.reportedCalls;
    row.inputTokens += event.inputTokens;
    row.outputTokens += event.outputTokens;
    if (event.reportedCalls > 0) row.costParts.push(event.costUsd ?? null);
    rows.set(key, row);
  }
  return [...rows.values()].map(({ costParts, ...row }) => ({
    ...row,
    costUsd: costParts.length === 0 ? null : sumKnownCostUsd(costParts),
  }));
}

const rowTokens = (row: ModelUsageRow) => row.inputTokens + row.outputTokens;

/**
 * Sums a turn's usage events into the answer line and the agent-details rows, or undefined when
 * the turn recorded none. Tokens and cost are the provider's reported numbers, never estimates; a
 * call that reported nothing is counted as unreported.
 */
export function summarizeModelUsage(events: readonly ModelUsageEvent[] | undefined): ModelUsageSummary | undefined {
  if (events === undefined || events.length === 0) return undefined;
  const rows = toRows(events);
  const byTokens = (a: ModelUsageRow, b: ModelUsageRow) => rowTokens(b) - rowTokens(a);
  const answerRow = [...rows.filter(row => row.role === 'chat')].sort(byTokens)[0] ?? [...rows].sort(byTokens)[0];
  if (answerRow === undefined) return undefined;
  const ordered = [answerRow, ...rows.filter(row => row !== answerRow)];
  const helpers = ordered.filter(row => row.role !== 'chat');
  const reportedCosts = ordered.filter(row => row.reportedCalls > 0).map(row => row.costUsd);
  const calls = ordered.reduce((sum, row) => sum + row.calls, 0);
  const reportedCalls = ordered.reduce((sum, row) => sum + row.reportedCalls, 0);
  return {
    answer: { displayName: answerRow.displayName, providerLabel: answerRow.providerLabel },
    inputTokens: ordered.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: ordered.reduce((sum, row) => sum + row.outputTokens, 0),
    costUsd: reportedCalls === 0 ? null : sumKnownCostUsd(reportedCosts),
    unreportedCalls: calls - reportedCalls,
    noneReported: reportedCalls === 0,
    rows: ordered,
    helperCalls: helpers.reduce((sum, row) => sum + row.calls, 0),
    helperModelNames: [...new Set(helpers.map(row => row.displayName))],
  };
}

function pluralize(count: number, singular: string): string {
  return `${formatTokens(count)} ${singular}${count === 1 ? '' : 's'}`;
}

/** "+ 2 helper calls on Nemotron 3 Nano", or undefined when there were none. */
export function describeHelperCalls(summary: ModelUsageSummary): string | undefined {
  if (summary.helperCalls === 0) return undefined;
  return `+ ${pluralize(summary.helperCalls, 'helper call')} on ${summary.helperModelNames.join(', ')}`;
}

/** "1,800 in, 340 out". */
export function describeTokenSplit({ inputTokens, outputTokens }: Pick<ModelUsageRow, 'inputTokens' | 'outputTokens'>) {
  return `${formatTokens(inputTokens)} in, ${formatTokens(outputTokens)} out`;
}
