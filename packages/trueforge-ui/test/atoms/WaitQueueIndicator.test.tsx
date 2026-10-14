// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WaitQueueIndicator } from '@/atoms/WaitQueueIndicator.js';
import { deriveWaitQueue, LONG_WAIT_MS, type TurnSpriteId, type WaitQueueSnapshot } from '@/utils/waitQueueJourney.js';

const SPRITES: TurnSpriteId[] = ['listening', 'remembering', 'found-memories', 'doing', 'writing', 'still-writing'];

function snapshot(overrides: Partial<WaitQueueSnapshot> = {}): WaitQueueSnapshot {
  return {
    stations: [
      { id: 'listening', label: 'Listening', state: 'done' },
      { id: 'doing', label: 'Doing', state: 'active' },
      { id: 'writing', label: 'Writing', state: 'pending' },
    ],
    activeStation: 'doing',
    recallJustLanded: false,
    microcopy: 'Searching the web…',
    ticks: ['Read schema.sql'],
    ...overrides,
  };
}

describe('WaitQueueIndicator', () => {
  it('renders the station track, the state sprite, and the live microcopy', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} reducedMotion={false} />);

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
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={20_000} reducedMotion={false} />);

    // The long-wait show is visible…
    expect(screen.getByText(/Still searching the web — 20s so far\./)).toBeInTheDocument();
    // …but the live region never carries the ticking number: it announces the
    // stable note once, not every second.
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(/20s/);
    expect(status).toHaveTextContent('this is taking longer than usual');
    expect(document.querySelector('.aui-wait-queue__longwait')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stays silent before the long-wait threshold', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={14_999} reducedMotion={false} />);

    expect(document.querySelector('.aui-wait-queue__longwait')).toBeNull();
  });

  it('renders the static show for reduced-motion users', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} reducedMotion />);

    expect(document.querySelector('.aui-wait-queue')).toHaveClass('aui-wait-queue--static');
  });

  it('keeps the sprite drawn in code for reduced-motion users', () => {
    render(<WaitQueueIndicator snapshot={snapshot()} elapsedMs={0} reducedMotion />);

    expect(document.querySelector('.aui-state-sprite--doing svg')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--doing img')).toBeNull();
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
        reducedMotion={false}
      />,
    );

    expect(document.querySelector('.aui-wait-queue__station--arriving')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--writing')).not.toBeNull();
  });

  it('walks remembering -> found-memories -> doing as the turn progresses', () => {
    const { rerender } = render(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: null, microcopy: 'Thinking it through…' })}
        elapsedMs={0}
        reducedMotion={false}
      />,
    );
    expect(document.querySelector('.aui-state-sprite--remembering')).not.toBeNull();

    rerender(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: null, recallJustLanded: true, microcopy: 'Thinking it through…' })}
        elapsedMs={0}
        reducedMotion={false}
      />,
    );
    expect(document.querySelector('.aui-state-sprite--found-memories')).not.toBeNull();

    rerender(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: 'doing', recallJustLanded: false })}
        elapsedMs={0}
        reducedMotion={false}
      />,
    );
    expect(document.querySelector('.aui-state-sprite--doing')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--found-memories')).toBeNull();
  });

  it('switches the writing sprite to still-writing past the long-wait threshold', () => {
    const writing = snapshot({ activeStation: 'writing', microcopy: 'Writing…', ticks: [] });
    const { rerender } = render(
      <WaitQueueIndicator snapshot={writing} elapsedMs={LONG_WAIT_MS - 1} reducedMotion={false} />,
    );
    expect(document.querySelector('.aui-state-sprite--writing')).not.toBeNull();

    rerender(<WaitQueueIndicator snapshot={writing} elapsedMs={LONG_WAIT_MS} reducedMotion={false} />);
    expect(document.querySelector('.aui-state-sprite--still-writing')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--writing')).toBeNull();
  });

  it('keeps a recall that lands after the first part out of found-memories', () => {
    // Real snapshot: recall landed, then a tool started. deriveWaitQueue
    // clears recallJustLanded once a part exists, so the indicator never
    // shows found-memories for a late recall.
    const late = deriveWaitQueue({
      isRunning: true,
      parts: [{ type: 'tool-call', statusType: 'running', toolName: 'web_search' }],
      memory: { available: true, landed: true, items: 2, outcome: 'ok' },
    });
    expect(late.recallJustLanded).toBe(false);
    render(<WaitQueueIndicator snapshot={late} elapsedMs={0} reducedMotion={false} />);
    expect(document.querySelector('.aui-state-sprite--doing')).not.toBeNull();
    expect(document.querySelector('.aui-state-sprite--found-memories')).toBeNull();
  });

  it('keeps the status line text unchanged per sprite state', () => {
    const { rerender } = render(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: 'writing', microcopy: 'Writing…' })}
        elapsedMs={0}
        reducedMotion={false}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Writing…');

    rerender(
      <WaitQueueIndicator
        snapshot={snapshot({ activeStation: 'writing', microcopy: 'Writing…' })}
        elapsedMs={LONG_WAIT_MS}
        reducedMotion={false}
      />,
    );
    // The sprite changes; the announced microcopy does not.
    expect(screen.getByRole('status')).toHaveTextContent('Writing…');
    expect(document.querySelector('.aui-state-sprite--still-writing')).not.toBeNull();
  });

  it.each(SPRITES)('renders the %s sprite in the same box (no layout shift)', sprite => {
    const { unmount } = render(
      <WaitQueueIndicator
        snapshot={snapshot({
          activeStation:
            sprite === 'doing'
              ? 'doing'
              : sprite === 'writing' || sprite === 'still-writing'
                ? 'writing'
                : sprite === 'listening'
                  ? 'listening'
                  : null,
          recallJustLanded: sprite === 'found-memories',
          microcopy: 'Working…',
          ticks: [],
        })}
        elapsedMs={sprite === 'still-writing' ? LONG_WAIT_MS : 0}
        reducedMotion={false}
      />,
    );

    const el = document.querySelector(`.aui-state-sprite--${sprite}`);
    expect(el).not.toBeNull();
    // Same single-box structure in every state: one inline SVG, no size variants.
    expect(el?.tagName).toBe('SPAN');
    expect(el?.querySelectorAll('svg')).toHaveLength(1);
    expect(el?.querySelectorAll('img')).toHaveLength(0);
    unmount();
  });

  it('sizes the sprite box once in CSS (2rem, no per-state overrides)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css'), 'utf8');
    const boxRule = css.match(/\.aui-state-sprite\s*\{[^}]*\}/);
    expect(boxRule).not.toBeNull();
    expect(boxRule?.[0]).toMatch(/width:\s*2rem/);
    expect(boxRule?.[0]).toMatch(/height:\s*2rem/);
    // No state modifier may resize the box.
    for (const sprite of SPRITES) {
      const stateRule = css.match(new RegExp(`\\.aui-state-sprite--${sprite}\\s*\\{[^}]*\\}`));
      if (stateRule) {
        expect(stateRule[0]).not.toMatch(/width|height/);
      }
    }
  });
});
