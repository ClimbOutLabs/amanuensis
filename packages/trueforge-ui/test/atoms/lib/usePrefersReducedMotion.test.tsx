// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePrefersReducedMotion } from '@/atoms/lib/usePrefersReducedMotion.js';

function Probe() {
  const reducedMotion = usePrefersReducedMotion();
  return <div data-testid="probe">{reducedMotion ? 'reduced' : 'full'}</div>;
}

type Listener = () => void;

function modernMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    listeners,
    stub: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_type: string, listener: Listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: Listener) => {
        listeners.delete(listener);
      },
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('mounts as full motion when matchMedia is unavailable', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('full');
  });

  it('reads the reduce preference and cleans up its subscription', () => {
    const { listeners, stub } = modernMatchMedia(true);
    vi.stubGlobal('matchMedia', stub);

    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('reduced');
    expect(listeners.size).toBe(1);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it('reflects preference changes live', () => {
    let matches = false;
    const listeners = new Set<Listener>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: (_type: string, listener: Listener) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: Listener) => {
          listeners.delete(listener);
        },
      })),
    );

    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('full');

    act(() => {
      matches = true;
      listeners.forEach(listener => listener());
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('reduced');
  });
});
