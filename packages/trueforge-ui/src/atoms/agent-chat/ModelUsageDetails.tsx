'use client';

import type { ReactNode } from 'react';

import {
  describeListPriceCost,
  describeTokenSplit,
  formatTokens,
  type ModelUsageRow,
  type ModelUsageSummary,
} from '../../utils/modelUsage.js';

function rowFigures(row: ModelUsageRow): string {
  if (row.reportedCalls === 0) return 'usage not reported';
  const parts = [`${formatTokens(row.inputTokens + row.outputTokens)} tokens (${describeTokenSplit(row)})`];
  if (row.costUsd !== null) parts.push(describeListPriceCost(row.costUsd));
  return parts.join(' · ');
}

/**
 * Agent details for one turn's model calls: every role that ran, on which model, with the calls,
 * tokens and cost it used. The answer's own row comes first.
 */
export function ModelUsageDetails({ summary }: { summary: ModelUsageSummary }): ReactNode {
  return (
    <section aria-label="Model calls" data-testid="model-usage-details" className="mb-2 text-xs text-text-secondary">
      <ul className="flex flex-col gap-0.5">
        {summary.rows.map(row => (
          <li
            key={`${row.role}:${row.providerLabel}:${row.displayName}`}
            data-testid="model-usage-row"
            className="flex flex-wrap gap-x-1.5"
          >
            <span className="font-medium text-text-primary">{row.roleLabel}</span>
            <span aria-hidden>·</span>
            <span>
              {row.displayName}, {row.providerLabel}
            </span>
            <span aria-hidden>·</span>
            <span>{row.calls === 1 ? '1 call' : `${row.calls} calls`}</span>
            <span aria-hidden>·</span>
            <span>{rowFigures(row)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
