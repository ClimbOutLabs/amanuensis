// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModelUsageDetails } from '@/atoms/agent-chat/ModelUsageDetails.js';
import { ModelUsageLine } from '@/atoms/agent-chat/ModelUsageLine.js';
import { summarizeModelUsage, type ModelUsageSummary } from '@/utils/modelUsage.js';
import { NANO_COMPACTION_EVENT, NANO_SUMMARY_EVENT, SUPER_EVENT } from '../fixtures/modelUsageEvents.js';

function summaryOf(...events: Parameters<typeof summarizeModelUsage>[0] & unknown[]): ModelUsageSummary {
  const summary = summarizeModelUsage(events);
  if (summary === undefined) throw new Error('expected a summary');
  return summary;
}

describe('ModelUsageLine', () => {
  it('names the model and provider with the reported tokens and cost', () => {
    render(<ModelUsageLine summary={summaryOf(SUPER_EVENT)} />);

    expect(screen.getByTestId('model-usage-line')).toHaveTextContent(
      'Nemotron 3 Super · Token Factory · 2,140 tokens (1,800 in, 340 out) · $0.0008',
    );
    expect(screen.queryByTestId('model-usage-helpers')).not.toBeInTheDocument();
  });

  it('folds helper calls into the total and names the model they ran on', () => {
    render(<ModelUsageLine summary={summaryOf(SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT)} />);

    const line = screen.getByTestId('model-usage-line');
    expect(line).toHaveTextContent('Nemotron 3 Super · Token Factory · 6,990 tokens (6,300 in, 690 out) · $0.0012');
    expect(screen.getByTestId('model-usage-helpers')).toHaveTextContent('+ 2 helper calls on Nemotron 3 Nano');
  });

  it('shows tokens only when the model has no known price', () => {
    render(
      <ModelUsageLine
        summary={summaryOf({ ...SUPER_EVENT, provider: 'custom', displayName: 'local-model', costUsd: null })}
      />,
    );

    const line = screen.getByTestId('model-usage-line');
    expect(line).toHaveTextContent('local-model · Custom provider · 2,140 tokens (1,800 in, 340 out)');
    expect(line).not.toHaveTextContent('$');
  });

  it('says usage was not reported instead of showing zeros', () => {
    render(
      <ModelUsageLine
        summary={summaryOf({ ...SUPER_EVENT, reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null })}
      />,
    );

    const line = screen.getByTestId('model-usage-line');
    expect(line).toHaveTextContent('Nemotron 3 Super · Token Factory · usage not reported');
    expect(line).not.toHaveTextContent('0 tokens');
  });

  it('notes calls that reported no usage next to the ones that did', () => {
    render(
      <ModelUsageLine
        summary={summaryOf(SUPER_EVENT, {
          ...NANO_SUMMARY_EVENT,
          reportedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        })}
      />,
    );

    expect(screen.getByTestId('model-usage-line')).toHaveTextContent('usage not reported for 1 call');
  });
});

describe('ModelUsageDetails', () => {
  it('lists each role with its model, calls, tokens and cost', () => {
    render(<ModelUsageDetails summary={summaryOf(SUPER_EVENT, NANO_SUMMARY_EVENT, NANO_COMPACTION_EVENT)} />);

    const rows = screen.getAllByTestId('model-usage-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(
      'Answer·Nemotron 3 Super, Token Factory·2 calls·2,140 tokens (1,800 in, 340 out) · $0.0008',
    );
    expect(rows[1]).toHaveTextContent(
      'Memory summary·Nemotron 3 Nano, Token Factory·1 call·550 tokens (500 in, 50 out) · <$0.0001',
    );
    expect(rows[2]).toHaveTextContent(
      'Compaction·Nemotron 3 Nano, Token Factory·1 call·4,300 tokens (4,000 in, 300 out) · $0.0003',
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
