'use client';

import type { ReactNode } from 'react';

import { describeModelUsage, LIST_PRICE_HINT, type ModelUsageSummary } from '../../utils/modelUsage.js';

/**
 * Which model answered, on which provider, and what the whole turn used, helper calls included.
 * Tokens are the provider's reported usage; cost is a list-price estimate and is labelled so.
 */
export function ModelUsageOverview({ summary }: { summary: ModelUsageSummary }): ReactNode {
  return (
    <dl data-testid="model-usage-overview" className="mt-2 flex flex-col gap-0.5 text-xs text-text-tertiary">
      {describeModelUsage(summary).map(fact => (
        <div key={fact.key} data-testid={`model-usage-${fact.key}`} className="flex flex-wrap gap-x-1">
          <dt className="font-medium text-text-secondary">{fact.label}:</dt>{' '}
          <dd title={fact.key === 'cost' ? LIST_PRICE_HINT : undefined}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
