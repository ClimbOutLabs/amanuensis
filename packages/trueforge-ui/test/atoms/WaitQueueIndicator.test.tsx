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
  it('renders the station track, the state sprite, and the live microcopy', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} quietMs={0} reducedMotion={false} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Searching the web…');
    expect(status).toHaveTextContent('Read schema.sql');

    // The sprite mirrors the active station: doing -> doing sprite.
    expect(document.querySelector('.aui-state-sprite--doing')).not.toBeNull();

    const track = document.querySelector('.aui-wait-queue__track');
    expect(track?.getAttribute('aria-hidden')).toBe('true');
    expect(track?.querySelector('.aui-wait-queue__station--active .aui-wait-queue__label')).toHaveTextContent('Doing');
  });

  it('keeps the ticking clock out of the live region', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={20_000} quietMs={20_000} reducedMotion={false} />);

    // The long-wait show is visible…
    expect(screen.getByText(/Still searching the web — 20s so far\./)).toBeInTheDocument();
    // …but the live region never carries the ticking number: it announces the
    // stable note once, not every second.
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(/20s/);
    expect(status).toHaveTextContent('this is taking longer than usual');
    expect(document.querySelector('.aui-wait-queue__longwait')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stays silent on a long turn while things keep arriving', () => {
    render(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: null, microcopy: 'Reasoning… 1,240 words so far', ticks: [] })}
        elapsedMs={60_000}
        quietMs={2_000}
        reducedMotion={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Reasoning… 1,240 words so far');
    expect(document.querySelector('.aui-wait-queue__longwait')).toBeNull();
    expect(screen.queryByText(/taking longer than usual/)).not.toBeInTheDocument();
  });

  it('says it is taking longer than usual once nothing has arrived for a while', () => {
    render(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: null, microcopy: 'Thinking it through…', ticks: [] })}
        elapsedMs={60_000}
        quietMs={16_000}
        reducedMotion={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('this is taking longer than usual');
    expect(screen.getByText(/Still thinking it through — 1m 0s so far\./)).toBeInTheDocument();
  });

  it('stays silent before the long-wait threshold', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={14_999} quietMs={14_999} reducedMotion={false} />);

    expect(document.querySelector('.aui-wait-queue__longwait')).toBeNull();
  });

  it('renders the static show for reduced-motion users', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} quietMs={0} reducedMotion />);

    expect(document.querySelector('.aui-wait-queue')).toHaveClass('aui-wait-queue--static');
  });

  it('marks the Writing station as arriving when the first tokens land', () => {
    render(
      <WaitQueueIndicator
        snapshot={snapshot({
          stations: [
            { id: 'listening', label: 'Listening', state: 'done' },
            { id: 'doing', label: 'Doing', state: 'done' },
            { id: 'writing', label: 'Writing', state: 'active' },
          ],
          activeStation: 'writing',
          microcopy: 'Writing…',
          ticks: [],
        })}
        elapsedMs={0}
        quietMs={0}
        reducedMotion={false}
      />,
    );

    expect(document.querySelector('.aui-wait-queue__station--arriving')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--writing')).not.toBeNull();
  });
});
