// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModelUsageDetails } from '@/atoms/agent-chat/ModelUsageDetails.js';
import { ModelUsageOverview } from '@/atoms/agent-chat/ModelUsageOverview.js';
import { summarizeModelUsage, type ModelUsageSummary } from '@/utils/modelUsage.js';
import { NANO_COMPACTION_EVENT, NANO_SUMMARY_EVENT, SUPER_EVENT } from '../fixtures/modelUsageEvents.js';

function summaryOf(...events: Parameters<typeof summarizeModelUsage>[0] & unknown[]): ModelUsageSummary {
  const summary = summarizeModelUsage(events);
  if (summary === undefined) throw new Error('expected a summary');
  return summary;
}

function rowText(key: string): string | null {
  return screen.getByTestId(`model-usage-${key}`).textContent;
}

describe('ModelUsageOverview', () => {
  it('shows labelled rows for the model, tokens and cost', () => {
    render(<ModelUsageOverview summary={summaryOf(SUPER_EVENT)} />);

    expect(rowText('model')).toBe('Model: Nemotron 3 Super (Token Factory)');
    expect(rowText('tokens')).toBe('Tokens: 2,140 (1,800 in, 340 out)');
    expect(rowText('cost')).toBe('Cost: $0.0008 at list price');
    expect(screen.getByTestId('model-usage-overview')).not.toHaveTextContent('·');
  });

  it('leaves the helper calls row out when none ran', () => {
    render(<ModelUsageOverview summary={summaryOf(SUPER_EVENT)} />);

    expect(screen.queryByTestId('model-usage-helpers')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-usage-overview')).not.toHaveTextContent('Helper calls');
  });

  it('says the helper calls ran on the same model as the answer', () => {
    const custom = { ...SUPER_EVENT, provider: 'custom', displayName: 'deepseek-v4-flash-vision-exp', costUsd: null };
    render(
      <ModelUsageOverview
        summary={summaryOf(
          { ...custom, calls: 1, reportedCalls: 1, inputTokens: 27_000, outputTokens: 150 },
          {
            ...custom,
            id: 'helper',
            role: 'summarization',
            calls: 1,
            reportedCalls: 1,
            inputTokens: 306,
            outputTokens: 17,
          },
        )}
      />,
    );

    expect(rowText('model')).toBe('Model: deepseek-v4-flash-vision-exp (custom provider)');
    expect(rowText('tokens')).toBe('Tokens: 27,473 (27,306 in, 167 out)');
    expect(rowText('helpers')).toBe('Helper calls: 1, same model');
  });

  it('names the model the helper calls ran on when it differs from the answer', () => {
    render(<ModelUsageOverview summary={summaryOf(SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT)} />);

    expect(rowText('tokens')).toBe('Tokens: 6,990 (6,300 in, 690 out)');
    expect(rowText('helpers')).toBe('Helper calls: 2, on Nemotron 3 Nano');
  });

  it('labels the cost as a list-price estimate, never as the bill', () => {
    render(<ModelUsageOverview summary={summaryOf(SUPER_EVENT)} />);

    expect(screen.getByTestId('model-usage-cost').querySelector('dd')).toHaveAttribute(
      'title',
      'Estimated from per-million-token list prices, not your bill.',
    );
  });

  it('leaves the cost row out when the model has no known price', () => {
    render(<ModelUsageOverview summary={summaryOf({ ...SUPER_EVENT, costUsd: null })} />);

    expect(screen.queryByTestId('model-usage-cost')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-usage-overview')).not.toHaveTextContent('$');
  });

  it('says usage was not reported instead of showing zeros', () => {
    render(
      <ModelUsageOverview
        summary={summaryOf({ ...SUPER_EVENT, reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null })}
      />,
    );

    expect(rowText('tokens')).toBe('Tokens: not reported');
  });

  it('notes calls that reported no usage next to the ones that did', () => {
    render(
      <ModelUsageOverview
        summary={summaryOf(SUPER_EVENT, {
          ...NANO_SUMMARY_EVENT,
          reportedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        })}
      />,
    );

    expect(rowText('tokens')).toBe('Tokens: 2,140 (1,800 in, 340 out), not reported for 1 call');
  });
});

describe('ModelUsageDetails', () => {
  it('lists each role with its model, calls, tokens and cost', () => {
    render(<ModelUsageDetails summary={summaryOf(SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT)} />);

    const rows = screen.getAllByTestId('model-usage-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(
      'Answer·Nemotron 3 Super, Token Factory·2 calls·2,140 tokens (1,800 in, 340 out) · $0.0008 at list price',
    );
    expect(rows[1]).toHaveTextContent(
      'Memory summary·Nemotron 3 Nano, Token Factory·1 call·550 tokens (500 in, 50 out) · <$0.0001 at list price',
    );
    expect(rows[2]).toHaveTextContent(
      'Compaction·Nemotron 3 Nano, Token Factory·1 call·4,300 tokens (4,000 in, 300 out) · $0.0003 at list price',
    );
  });

  it('marks a row whose calls reported no usage', () => {
    render(
      <ModelUsageDetails
        summary={summaryOf(SUPER_EVENT, {
          ...NANO_SUMMARY_EVENT,
          reportedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        })}
      />,
    );

    expect(screen.getAllByTestId('model-usage-row')[1]).toHaveTextContent('usage not reported');
  });
});
