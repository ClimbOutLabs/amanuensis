// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIsMobile } from '@/atoms/lib/useIsMobile.js';

function Probe() {
  const isMobile = useIsMobile();
  return <div data-testid="probe">{isMobile ? 'mobile' : 'desktop'}</div>;
}

type Listener = () => void;

function legacyMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    listeners,
    stub: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addListener: (listener: Listener) => {
        listeners.add(listener);
      },
      removeListener: (listener: Listener) => {
        listeners.delete(listener);
      },
    })),
  };
}

function modernMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    listeners,
    stub: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
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

describe('useIsMobile', () => {
  it('mounts as desktop when matchMedia is unavailable', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('desktop');
  });

  it('mounts without crashing on legacy addListener-only MediaQueryList implementations', () => {
    // Regression test: Safari < 14 and some older webviews expose only
    // addListener/removeListener. Mounting used to throw
    // "media.addEventListener is not a function", crashing ThreadListContainer
    // (via AgentHistoryFilterButton / ChatFolderControls).
    const { listeners, stub } = legacyMatchMedia(true);
    vi.stubGlobal('matchMedia', stub);

    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('mobile');
    expect(listeners.size).toBe(1);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it('subscribes and unsubscribes with the modern addEventListener API', () => {
    const { listeners, stub } = modernMatchMedia(false);
    vi.stubGlobal('matchMedia', stub);

    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('desktop');
    expect(listeners.size).toBe(1);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it('reflects media query changes', () => {
    let matches = false;
    const listeners = new Set<Listener>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        media: '(max-width: 767px)',
        addEventListener: (_type: string, listener: Listener) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: Listener) => {
          listeners.delete(listener);
        },
      })),
    );

    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('desktop');

    act(() => {
      matches = true;
      listeners.forEach(listener => listener());
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('mobile');
  });
});
