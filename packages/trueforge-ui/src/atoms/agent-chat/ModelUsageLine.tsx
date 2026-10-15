'use client';

import type { ReactNode } from 'react';

import {
  describeHelperCalls,
  describeTokenSplit,
  formatCostUsd,
  formatTokens,
  type ModelUsageSummary,
} from '../../utils/modelUsage.js';

/**
 * The quiet line under an answer: which model answered, on which provider, and what the whole turn
 * cost, helper calls included. Numbers are the provider's reported usage; a turn whose provider
 * reported none says so rather than showing zero.
 */
export function ModelUsageLine({ summary }: { summary: ModelUsageSummary }): ReactNode {
  const helpers = describeHelperCalls(summary);
  const totalTokens = summary.inputTokens + summary.outputTokens;
  return (
    <p data-testid="model-usage-line" className="mt-2 text-xs text-text-tertiary">
      <span>{summary.answer.displayName}</span>
      <span aria-hidden> · </span>
      <span>{summary.answer.providerLabel}</span>
      <span aria-hidden> · </span>
      {summary.noneReported ? (
        <span>usage not reported</span>
      ) : (
        <>
          <span>
            {formatTokens(totalTokens)} tokens ({describeTokenSplit(summary)})
          </span>
          {summary.costUsd === null ? null : (
            <>
              <span aria-hidden> · </span>
              <span>{formatCostUsd(summary.costUsd)}</span>
            </>
          )}
          {summary.unreportedCalls > 0 ? (
            <>
              <span aria-hidden> · </span>
              <span>
                usage not reported for {summary.unreportedCalls === 1 ? '1 call' : `${summary.unreportedCalls} calls`}
              </span>
            </>
          ) : null}
        </>
      )}
      {helpers === undefined ? null : (
        <>
          <span aria-hidden> · </span>
          <span data-testid="model-usage-helpers">{helpers}</span>
        </>
      )}
    </p>
  );
}
