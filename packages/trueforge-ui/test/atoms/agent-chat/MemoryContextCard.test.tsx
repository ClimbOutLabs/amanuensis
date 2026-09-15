// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it, vi } from 'vitest';

import { MemoryContextCard } from '@/atoms/agent-chat/MemoryContextCard.js';

const recallEvent: TrueForgeApi.MemoryRecallPersistedEvent = {
  type: 'aman.memory.recall',
  id: 'evt_recall_1',
  createdAt: '2026-08-03T00:00:00.000Z',
  injectedBlock: '<aman-memory>recalled fact</aman-memory>',
  stats: {
    items: 1,
    entities: 2,
    droppedOverBudget: 0,
    droppedBelowThreshold: 0,
    estimatedTokens: 42,
    recallMs: 17,
    budgetReason: 'normal',
    outcome: 'ok',
  },
  sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
};

describe('MemoryContextCard', () => {
  it('renders nothing when neither recall nor profile happened and the fetch is not failing', () => {
    const { container } = render(<MemoryContextCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pluralizes counts correctly at one and at other counts, including an irregular plural', () => {
    render(<MemoryContextCard recall={recallEvent} />);
    // The collapsed status line already exercises both the singular form (1 item) and the
    // irregular plural (2 entities, not "entitys").
    expect(screen.getByText('1 item, 2 entities')).toBeInTheDocument();

    // Expand to also check the same counts rendered as their own rows in the body.
    fireEvent.click(screen.getByRole('button', { name: 'Expand step' }));
    expect(screen.getByText('1 item')).toBeInTheDocument();
    expect(screen.getByText('2 entities')).toBeInTheDocument();
  });

  it('shows an actionable unavailable state instead of rendering as if nothing happened', () => {
    const onRetry = vi.fn();
    render(<MemoryContextCard unavailable onRetry={onRetry} />);

    expect(screen.getByTestId('memory-context-card')).toBeInTheDocument();
    expect(screen.getByText('Memory context unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('memory-context-unavailable-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('prefers loaded data over the unavailable flag', () => {
    render(<MemoryContextCard recall={recallEvent} unavailable />);
    expect(screen.queryByText('Memory context unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('Recalled memory')).toBeInTheDocument();
  });
});
