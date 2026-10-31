// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WaitQueueIndicator } from '@/atoms/WaitQueueIndicator.js';
import type { WaitQueueSnapshot } from '@/utils/waitQueueJourney.js';

function snapshot(overrides: Partial<WaitQueueSnapshot> = {}): WaitQueueSnapshot {
  return {
    stations: [
      { id: 'listening', label: 'Listening', state: 'done' },
      { id: 'doing', label: 'Doing', state: 'active' },
      { id: 'writing', label: 'Writing', state: 'pending' },
    ],
    activeStation: 'doing',
    microcopy: 'Searching the web…',
    ticks: ['Read schema.sql'],
    ...overrides,
  };
}

describe('WaitQueueIndicator', () => {
  it('renders exactly one status line: the sprite and the plain words, with no track or stacked ticks', () => {
    const { container } = render(
      <WaitQueueIndicator
        snapshot={snapshot({ ticks: ['Found 5 memories'] })}
        elapsedMs={0}
        quietMs={0}
        reducedMotion={false}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Searching the web…');
    expect(document.querySelector('.aui-state-sprite--doing')).not.toBeNull();
    // The step names and finished steps never stack as visible lines.
    for (const label of ['Listening', 'Remembering', 'Doing', 'Writing']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    const visibleText = Array.from(container.querySelectorAll('span:not(.sr-only)'))
      .filter(el => el.closest('.sr-only') === null)
      .map(el => el.childNodes)
      .flatMap(nodes => Array.from(nodes))
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent ?? '')
      .join('');
    expect(visibleText.match(/Found 5 memories/g) ?? []).toHaveLength(0);
  });

  it('turns the same line into "Still …" with whole minutes after a quiet spell', () => {
    render(
      <WaitQueueIndicator
        snapshot={snapshot({ microcopy: 'Writing…', activeStation: 'writing' })}
        elapsedMs={125_000}
        quietMs={20_000}
        reducedMotion={false}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Still writing… 2 min');
    expect(screen.queryByText(/—/)).not.toBeInTheDocument();
  });

  it('keeps the plain words while things keep arriving on a long turn', () => {
    render(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: null, microcopy: 'Reasoning… 1,240 words so far', ticks: [] })}
        elapsedMs={60_000}
        quietMs={2_000}
        reducedMotion={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Reasoning… 1,240 words so far');
    expect(screen.queryByText(/^Still/)).not.toBeInTheDocument();
  });

  it('says it is still at it without a number before the first whole minute', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={20_000} quietMs={20_000} reducedMotion={false} />);

    expect(document.querySelector('.aui-wait-queue__microcopy')).toHaveTextContent(/^Still searching the web…$/);
  });

  it('renders the static show for reduced-motion users', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} quietMs={0} reducedMotion />);

    expect(document.querySelector('.aui-wait-queue')).toHaveClass('aui-wait-queue--static');
  });
});
